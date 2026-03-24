import * as vscode from 'vscode';
import { loadHelidonConfigMetadata } from './metadata';

export interface HelidonConfigProperty {
	key: string;
	type: string;
	defaultValue?: string;
	description: string;
	example?: string;
}

export const HELIDON_CONFIG_PROPERTIES: HelidonConfigProperty[] = loadHelidonConfigMetadata();

const HELIDON_CONFIG_PROPERTY_MAP = new Map(
	HELIDON_CONFIG_PROPERTIES.map((property) => [property.key, property] as const)
);

function propertyMarkdown(property: HelidonConfigProperty): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	markdown.appendMarkdown(`**${property.key}**\n\n`);
	markdown.appendMarkdown(`${property.description}\n\n`);
	markdown.appendMarkdown(`- Type: \`${property.type}\`\n`);
	if (property.defaultValue) {
		markdown.appendMarkdown(`- Default: \`${property.defaultValue}\`\n`);
	}
	if (property.example) {
		markdown.appendMarkdown(`- Example: \`${property.example}\`\n`);
	}
	markdown.isTrusted = false;
	return markdown;
}

export function findHelidonConfigProperty(key: string): HelidonConfigProperty | undefined {
	return HELIDON_CONFIG_PROPERTY_MAP.get(key);
}

function toYamlPathSegments(key: string): string[] {
	return key.split('.');
}

function isYamlLanguage(languageId: string): boolean {
	return languageId === 'yaml';
}

export function isHelidonYamlDocument(document: vscode.TextDocument): boolean {
	if (!isYamlLanguage(document.languageId)) {
		return false;
	}

	const fileName = document.fileName.toLowerCase();
	return fileName.endsWith('application.yaml') || fileName.endsWith('application.yml');
}

function yamlIndent(text: string): number {
	const match = text.match(/^(\s*)/);
	return match ? match[1].length : 0;
}

function currentYamlPath(document: vscode.TextDocument, position: vscode.Position): string[] {
	const segments: string[] = [];
	const stack: Array<{ indent: number; key: string }> = [];

	for (let lineIndex = 0; lineIndex <= position.line; lineIndex++) {
		const line = document.lineAt(lineIndex).text;
		const trimmed = line.trim();

		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}

		const keyMatch = /^([A-Za-z0-9_-]+):/.exec(trimmed);
		if (!keyMatch) {
			continue;
		}

		const indent = yamlIndent(line);
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}

		stack.push({ indent, key: keyMatch[1] });
	}

	for (const item of stack) {
		segments.push(item.key);
	}

	const currentLine = document.lineAt(position.line).text;
	const beforeCursor = currentLine.slice(0, position.character);
	const partialKeyMatch = /([A-Za-z0-9_-]*)$/.exec(beforeCursor);
	const partialKey = partialKeyMatch?.[1] ?? '';

	if (currentLine.trim().startsWith(partialKey) && segments.length > 0) {
		segments.pop();
	}

	if (partialKey.length > 0) {
		segments.push(partialKey);
	}

	return segments;
}

function nextYamlSegmentSuggestions(pathSegments: string[]): HelidonConfigProperty[] {
	const prefix = pathSegments.join('.');
	const normalizedPrefix = prefix.length > 0 ? `${prefix}.` : '';

	return HELIDON_CONFIG_PROPERTIES.filter((property) => {
		if (prefix.length === 0) {
			return true;
		}

		return property.key === prefix || property.key.startsWith(normalizedPrefix);
		});
}

function yamlCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
	const pathSegments = currentYamlPath(document, position);
	const parentSegments = pathSegments.slice(0, -1);
	const partialSegment = pathSegments[pathSegments.length - 1] ?? '';
	const parentPrefix = parentSegments.join('.');

	const suggestions = new Map<string, HelidonConfigProperty>();
	for (const property of nextYamlSegmentSuggestions(parentSegments)) {
		const segments = toYamlPathSegments(property.key);
		const nextSegment = segments[parentSegments.length];
		if (!nextSegment || !nextSegment.startsWith(partialSegment)) {
			continue;
		}

		if (!suggestions.has(nextSegment)) {
			suggestions.set(nextSegment, property);
		}
	}

	const keyRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_-]+/);

	return [...suggestions.entries()].map(([segment, property]) => {
		const item = new vscode.CompletionItem(segment, vscode.CompletionItemKind.Property);
		const fullKey = parentPrefix ? `${parentPrefix}.${segment}` : segment;
		item.detail = `Helidon YAML key (${fullKey})`;
		item.documentation = propertyMarkdown(property);
		item.insertText = segment;
		item.sortText = fullKey;
		if (keyRange) {
			item.range = keyRange;
		}
		return item;
	});
}

function hoverForYaml(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
	const line = document.lineAt(position.line).text;
	const keyRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_-]+/);
	if (!keyRange) {
		return undefined;
	}

	const key = document.getText(keyRange);
	if (!line.trimStart().startsWith(key)) {
		return undefined;
	}

	const stack: Array<{ indent: number; key: string }> = [];
	for (let lineIndex = 0; lineIndex <= position.line; lineIndex++) {
		const candidate = document.lineAt(lineIndex).text;
		const trimmed = candidate.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}

		const keyMatch = /^([A-Za-z0-9_-]+):/.exec(trimmed);
		if (!keyMatch) {
			continue;
		}

		const indent = yamlIndent(candidate);
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}
		stack.push({ indent, key: keyMatch[1] });
	}

	const fullKey = stack.map((item) => item.key).join('.');
	const property = findHelidonConfigProperty(fullKey);
	if (!property) {
		return undefined;
	}

	return new vscode.Hover(propertyMarkdown(property), keyRange);
}

export function isHelidonPropertiesDocument(document: vscode.TextDocument): boolean {
	if (document.languageId !== 'properties') {
		return false;
	}

	const fileName = document.fileName.toLowerCase();
	return fileName.endsWith('application.properties');
}

export class HelidonPropertiesCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.CompletionItem[]> {
		if (!isHelidonPropertiesDocument(document)) {
			return undefined;
		}

		const line = document.lineAt(position).text;
		const beforeCursor = line.slice(0, position.character);

		if (beforeCursor.trimStart().startsWith('#') || beforeCursor.includes('=')) {
			return undefined;
		}

		const keyRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9._-]+/);
		const currentPrefix = keyRange ? document.getText(keyRange) : beforeCursor.trim();

		return HELIDON_CONFIG_PROPERTIES
			.filter((property) => currentPrefix.length === 0 || property.key.startsWith(currentPrefix))
			.map((property) => {
				const item = new vscode.CompletionItem(property.key, vscode.CompletionItemKind.Property);
				item.detail = `Helidon configuration (${property.type})`;
				item.documentation = propertyMarkdown(property);
				item.insertText = property.key;
				item.sortText = property.key;
				if (keyRange) {
					item.range = keyRange;
				}
				return item;
			});
	}
}

export class HelidonYamlCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.CompletionItem[]> {
		if (!isHelidonYamlDocument(document)) {
			return undefined;
		}

		return yamlCompletionItems(document, position);
	}
}

export class HelidonPropertiesHoverProvider implements vscode.HoverProvider {
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.Hover> {
		if (isHelidonYamlDocument(document)) {
			return hoverForYaml(document, position);
		}

		if (!isHelidonPropertiesDocument(document)) {
			return undefined;
		}

		const keyRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9._-]+/);
		if (!keyRange) {
			return undefined;
		}

		const key = document.getText(keyRange);
		const property = findHelidonConfigProperty(key);
		if (!property) {
			return undefined;
		}

		return new vscode.Hover(propertyMarkdown(property), keyRange);
	}
}
