import * as vscode from 'vscode';
import {
	findJavaPathParameterReference,
	parseJavaSourceModel,
	type JavaAnnotationInfo,
	type JavaClassInfo,
	type JavaSourceModel,
} from './javaSource';
import { executeJavaWorkspaceCommand } from './javaMetadata';

const JAVA_ENDPOINT_GLOB = '**/*.java';
const JAVA_ENDPOINT_EXCLUDE_GLOB = '**/{.git,.gradle,.idea,node_modules,target}/**';
const HTTP_METHOD_ANNOTATIONS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
export const HELIDON_ENDPOINT_DISCOVERY_COMMAND = 'io.helidon.vscode.resolveEndpoints';
const HELIDON_ENDPOINT_DISCOVERY_REQUEST_VERSION = 1;

export interface HelidonEndpoint {
	className: string;
	methodName: string;
	httpMethod: string;
	path: string;
	relativePath: string;
	uri: vscode.Uri;
	line: number;
}

interface HelidonEndpointGroup {
	className: string;
	relativePath: string;
	uri: vscode.Uri;
	line: number;
	endpoints: HelidonEndpoint[];
}

type HelidonEndpointDiscoverySource = 'semantic' | 'source-parser';
type HelidonDocumentSymbol = vscode.DocumentSymbol | vscode.SymbolInformation;
const SEMANTIC_PATH_PARAMETER_ACCESS_PATTERN =
	/(?:\.\s*path\s*\(\s*\)\s*\.\s*param|\.\s*pathParameters\s*\(\s*\)\s*\.\s*(?:first|get))\s*\($/su;

export interface HelidonEndpointDiscoveryLogger {
	appendLine(message: string): void;
}

export interface HelidonEndpointDiscoveryResult {
	source: HelidonEndpointDiscoverySource;
	groups: HelidonEndpointGroup[];
	message: string;
}

export interface HelidonEndpointDiscoveryOptions {
	workspaceFolders?: readonly Pick<vscode.WorkspaceFolder, 'uri'>[];
	commandExecutor?: (command: string, requestJson: string) => Thenable<unknown>;
	fallbackProvider?: () => Promise<HelidonEndpointGroup[]>;
}

interface HelidonEndpointGroupDto {
	className: string;
	relativePath: string;
	uri: string;
	line: number;
	endpoints: HelidonEndpointDto[];
}

interface HelidonEndpointDto {
	className: string;
	methodName: string;
	httpMethod: string;
	path: string;
	relativePath: string;
	uri: string;
	line: number;
}

interface HelidonSemanticEndpointResponseDto {
	supported?: boolean;
	groups?: HelidonEndpointGroupDto[];
}

interface ParsedRouteDefinition {
	className: string;
	methodName: string;
	httpMethod: string;
	path: string;
	line: number;
}

export interface HelidonJavaMethodContext {
	name?: string;
	line: number;
	range: vscode.Range;
}

function normalizeEndpointPathSegment(path: string): string {
	const trimmed = path.trim();
	if (trimmed.length === 0 || trimmed === '/') {
		return '';
	}

	let start = 0;
	let end = trimmed.length;
	while (start < end && trimmed[start] === '/') {
		start += 1;
	}
	while (end > start && trimmed[end - 1] === '/') {
		end -= 1;
	}

	return trimmed.slice(start, end);
}

function joinEndpointPath(basePath: string, methodPath: string): string {
	const segments = [normalizeEndpointPathSegment(basePath), normalizeEndpointPathSegment(methodPath)].filter(
		(segment) => segment.length > 0
	);
	return `/${segments.join('/')}`;
}

function annotationSimpleName(annotationName: string): string {
	const separatorIndex = annotationName.lastIndexOf('.');
	return separatorIndex === -1 ? annotationName : annotationName.slice(separatorIndex + 1);
}

function annotationStringValue(annotations: readonly JavaAnnotationInfo[], annotationName: string): string | undefined {
	return annotations.find((annotation) => annotationSimpleName(annotation.name) === annotationName)?.stringValue;
}

function extractHttpMethod(annotations: readonly JavaAnnotationInfo[]): string | undefined {
	for (const method of HTTP_METHOD_ANNOTATIONS) {
		if (annotations.some((annotation) => annotationSimpleName(annotation.name) === method)) {
			return method;
		}
	}

	return undefined;
}

function walkJavaClasses(classes: readonly JavaClassInfo[], consumer: (classInfo: JavaClassInfo) => void): void {
	for (const classInfo of classes) {
		consumer(classInfo);
		walkJavaClasses(classInfo.innerClasses, consumer);
	}
}

function jaxRsEndpointsFromModel(model: JavaSourceModel): Omit<HelidonEndpoint, 'relativePath' | 'uri'>[] {
	const endpoints: Omit<HelidonEndpoint, 'relativePath' | 'uri'>[] = [];
	walkJavaClasses(model.classes, (classInfo) => {
		const classPath = annotationStringValue(classInfo.annotations, 'Path') ?? '';
		for (const method of classInfo.methods) {
			const httpMethod = extractHttpMethod(method.annotations);
			if (!httpMethod) {
				continue;
			}

			const methodPath = annotationStringValue(method.annotations, 'Path') ?? '';
			endpoints.push({
				className: classInfo.name,
				methodName: method.name,
				httpMethod,
				path: joinEndpointPath(classPath, methodPath),
				line: method.line,
			});
		}
	});

	return endpoints;
}

export async function parseJavaJaxRsEndpoints(source: string): Promise<Omit<HelidonEndpoint, 'relativePath' | 'uri'>[]> {
	const model = await parseJavaSourceModel(source);
	return model ? jaxRsEndpointsFromModel(model) : [];
}

// Source parsing intentionally supports JAX-RS only. Helidon SE discovery is left to the semantic/JDT flow.
export async function parseJavaHelidonRoutingEndpoints(source: string): Promise<ParsedRouteDefinition[]> {
	void source;
	return [];
}

async function scanWorkspaceEndpoints(): Promise<HelidonEndpointGroup[]> {
	const files = await vscode.workspace.findFiles(JAVA_ENDPOINT_GLOB, JAVA_ENDPOINT_EXCLUDE_GLOB);
	const groupedByClass = new Map<string, HelidonEndpointGroup>();

	for (const file of files) {
		const source = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
		const relativePath = vscode.workspace.asRelativePath(file, false);
		const model = await parseJavaSourceModel(source);
		const jaxRsEndpoints = model ? jaxRsEndpointsFromModel(model) : [];

		for (const endpoint of jaxRsEndpoints) {
			addEndpoint(groupedByClass, {
				...endpoint,
				relativePath,
				uri: file,
			});
		}
	}

	return [...groupedByClass.values()]
		.map((group) => ({
			...group,
			endpoints: group.endpoints.sort((left, right) =>
				left.path === right.path
					? left.httpMethod.localeCompare(right.httpMethod)
					: left.path.localeCompare(right.path)
			),
		}))
		.sort((left, right) =>
			left.className === right.className
				? left.relativePath.localeCompare(right.relativePath)
				: left.className.localeCompare(right.className)
		);
}

function addEndpoint(groups: Map<string, HelidonEndpointGroup>, endpoint: HelidonEndpoint): void {
	const key = `${endpoint.relativePath}#${endpoint.className}`;
	const existingGroup = groups.get(key);
	if (existingGroup) {
		existingGroup.endpoints.push(endpoint);
		existingGroup.line = Math.min(existingGroup.line, endpoint.line);
		return;
	}

	groups.set(key, {
		className: endpoint.className,
		relativePath: endpoint.relativePath,
		uri: endpoint.uri,
		line: endpoint.line,
		endpoints: [endpoint],
	});
}

function sortEndpointGroups(groups: readonly HelidonEndpointGroup[]): HelidonEndpointGroup[] {
	return [...groups]
		.map((group) => ({
			...group,
			endpoints: [...group.endpoints].sort((left, right) =>
				left.path === right.path
					? left.httpMethod.localeCompare(right.httpMethod)
					: left.path.localeCompare(right.path)
			),
		}))
		.sort((left, right) =>
			left.className === right.className
				? left.relativePath.localeCompare(right.relativePath)
				: left.className.localeCompare(right.className)
		);
}

function countEndpoints(groups: readonly HelidonEndpointGroup[]): number {
	return groups.reduce((count, group) => count + group.endpoints.length, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isDocumentSymbol(value: unknown): value is vscode.DocumentSymbol {
	return (
		isRecord(value)
		&& value.kind !== undefined
		&& value.range instanceof vscode.Range
		&& value.selectionRange instanceof vscode.Range
		&& Array.isArray(value.children)
	);
}

function isSymbolInformation(value: unknown): value is vscode.SymbolInformation {
	return isRecord(value) && value.kind !== undefined && value.location instanceof vscode.Location;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeJavaMemberName(name: string | undefined): string | undefined {
	if (!name) {
		return undefined;
	}

	const trimmed = name.trim();
	const match = /^([^(:\s]+)/u.exec(trimmed);
	return match?.[1];
}

function stringRangeScore(range: vscode.Range): number {
	return (range.end.line - range.start.line) * 100_000 + (range.end.character - range.start.character);
}

function escapedCharacterCount(source: string, index: number): number {
	let count = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
		count += 1;
	}

	return count;
}

function lineBounds(source: string, offset: number): { start: number; end: number } {
	const clampedOffset = Math.max(0, Math.min(offset, source.length));
	const start = source.lastIndexOf('\n', Math.max(0, clampedOffset - 1)) + 1;
	const end = source.indexOf('\n', clampedOffset);
	return {
		start,
		end: end === -1 ? source.length : end,
	};
}

export function findSemanticPathParameterReference(
	source: string,
	offset: number,
): { value: string; start: number; end: number } | undefined {
	const { start: lineStart, end: lineEnd } = lineBounds(source, offset);
	let quoteStart = -1;
	for (let index = Math.max(lineStart, offset - 1); index >= lineStart; index -= 1) {
		if (source[index] !== '"' || escapedCharacterCount(source, index) % 2 === 1) {
			continue;
		}

		quoteStart = index;
		break;
	}
	if (quoteStart === -1) {
		return undefined;
	}

	let quoteEnd = -1;
	for (let index = quoteStart + 1; index < lineEnd; index += 1) {
		if (source[index] !== '"' || escapedCharacterCount(source, index) % 2 === 1) {
			continue;
		}

		quoteEnd = index;
		break;
	}
	if (quoteEnd === -1 || offset < quoteStart + 1 || offset > quoteEnd) {
		return undefined;
	}

	const accessWindowStart = Math.max(0, quoteStart - 512);
	const accessPrefix = source.slice(accessWindowStart, quoteStart);
	if (!SEMANTIC_PATH_PARAMETER_ACCESS_PATTERN.test(accessPrefix)) {
		return undefined;
	}

	return {
		value: source.slice(quoteStart + 1, quoteEnd),
		start: quoteStart + 1,
		end: quoteEnd,
	};
}

async function defaultDocumentSymbolProvider(uri: vscode.Uri): Promise<readonly HelidonDocumentSymbol[]> {
	return (
		await vscode.commands.executeCommand<readonly HelidonDocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			uri
		)
	) ?? [];
}

function walkDocumentSymbols(
	symbols: readonly vscode.DocumentSymbol[],
	consumer: (symbol: vscode.DocumentSymbol) => void,
): void {
	for (const symbol of symbols) {
		consumer(symbol);
		walkDocumentSymbols(symbol.children, consumer);
	}
}

function javaMethodContextAtPosition(
	symbols: readonly HelidonDocumentSymbol[],
	position: vscode.Position,
): HelidonJavaMethodContext | undefined {
	let bestMatch: HelidonJavaMethodContext | undefined;
	const considerMatch = (name: string | undefined, line: number, range: vscode.Range) => {
		const candidate = {
			name: normalizeJavaMemberName(name),
			line,
			range,
		};
		if (!bestMatch || stringRangeScore(candidate.range) < stringRangeScore(bestMatch.range)) {
			bestMatch = candidate;
		}
	};

	for (const symbol of symbols) {
		if (isDocumentSymbol(symbol)) {
			walkDocumentSymbols([symbol], (nestedSymbol) => {
				if (
					(nestedSymbol.kind === vscode.SymbolKind.Method || nestedSymbol.kind === vscode.SymbolKind.Function)
					&& nestedSymbol.range.contains(position)
				) {
					considerMatch(nestedSymbol.name, nestedSymbol.selectionRange.start.line, nestedSymbol.range);
				}
			});
			continue;
		}

		if (
			isSymbolInformation(symbol)
			&& (symbol.kind === vscode.SymbolKind.Method || symbol.kind === vscode.SymbolKind.Function)
			&& symbol.location.range.contains(position)
		) {
			considerMatch(symbol.name, symbol.location.range.start.line, symbol.location.range);
		}
	}

	return bestMatch;
}

export function findPathParameterEndpointLocations(
	endpoints: readonly HelidonEndpoint[],
	parameterName: string,
	methodContext: HelidonJavaMethodContext,
): vscode.Location[] {
	const normalizedMethodName = normalizeJavaMemberName(methodContext.name);
	const seenLocations = new Set<string>();
	const locations: vscode.Location[] = [];

	for (const endpoint of endpoints) {
		if (!endpoint.path.includes(`{${parameterName}}`)) {
			continue;
		}

		const matchesMethod =
			(normalizedMethodName !== undefined && endpoint.methodName === normalizedMethodName)
			|| endpoint.line === methodContext.line;
		if (!matchesMethod) {
			continue;
		}

		const key = `${endpoint.uri.toString()}#${endpoint.line}`;
		if (seenLocations.has(key)) {
			continue;
		}
		seenLocations.add(key);
		locations.push(new vscode.Location(endpoint.uri, new vscode.Range(endpoint.line, 0, endpoint.line, 0)));
	}

	return locations;
}

function deserializeEndpoint(value: unknown): HelidonEndpoint | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (
		typeof value.className !== 'string' ||
		typeof value.methodName !== 'string' ||
		typeof value.httpMethod !== 'string' ||
		typeof value.path !== 'string' ||
		typeof value.relativePath !== 'string' ||
		typeof value.uri !== 'string' ||
		!isNonNegativeInteger(value.line)
	) {
		return undefined;
	}

	try {
		return {
			className: value.className,
			methodName: value.methodName,
			httpMethod: value.httpMethod,
			path: value.path,
			relativePath: value.relativePath,
			uri: vscode.Uri.parse(value.uri),
			line: value.line,
		};
	} catch {
		return undefined;
	}
}

function deserializeEndpointGroup(value: unknown): HelidonEndpointGroup | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (
		typeof value.className !== 'string' ||
		typeof value.relativePath !== 'string' ||
		typeof value.uri !== 'string' ||
		!isNonNegativeInteger(value.line) ||
		!Array.isArray(value.endpoints)
	) {
		return undefined;
	}

	const endpoints = value.endpoints.map(deserializeEndpoint);
	if (endpoints.some((endpoint) => endpoint === undefined)) {
		return undefined;
	}

	try {
		return {
			className: value.className,
			relativePath: value.relativePath,
			uri: vscode.Uri.parse(value.uri),
			line: value.line,
			endpoints: endpoints as HelidonEndpoint[],
		};
	} catch {
		return undefined;
	}
}

function normalizeSemanticEndpointResponse(
	value: unknown,
): { supported: boolean; groups: HelidonEndpointGroup[] } | undefined {
	if (Array.isArray(value)) {
		const groups = value.map(deserializeEndpointGroup);
		return groups.every((group) => group !== undefined)
			? { supported: true, groups: sortEndpointGroups(groups as HelidonEndpointGroup[]) }
			: undefined;
	}

	if (!isRecord(value)) {
		return undefined;
	}

	const response = value as HelidonSemanticEndpointResponseDto;
	if (response.supported === false) {
		return { supported: false, groups: [] };
	}

	if (response.supported !== true || !Array.isArray(response.groups)) {
		return undefined;
	}

	const groups = response.groups.map(deserializeEndpointGroup);
	return groups.every((group) => group !== undefined)
		? { supported: true, groups: sortEndpointGroups(groups as HelidonEndpointGroup[]) }
		: undefined;
}

function semanticEndpointDiscoveryRequestJson(workspaceFolders: readonly Pick<vscode.WorkspaceFolder, 'uri'>[]): string {
	return JSON.stringify({
		version: HELIDON_ENDPOINT_DISCOVERY_REQUEST_VERSION,
		workspaceFolderUris: workspaceFolders.map((folder) => folder.uri.toString()),
	});
}

async function defaultEndpointCommandExecutor(command: string, requestJson: string): Promise<unknown> {
	return executeJavaWorkspaceCommand(command, [requestJson]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function discoverHelidonEndpointGroups(
	options: HelidonEndpointDiscoveryOptions = {},
): Promise<HelidonEndpointDiscoveryResult> {
	const workspaceFolders = options.workspaceFolders ?? vscode.workspace.workspaceFolders ?? [];
	const commandExecutor = options.commandExecutor ?? defaultEndpointCommandExecutor;
	const fallbackProvider = options.fallbackProvider ?? scanWorkspaceEndpoints;

	if (workspaceFolders.length > 0) {
		try {
			const rawResponse = await commandExecutor(
				HELIDON_ENDPOINT_DISCOVERY_COMMAND,
				semanticEndpointDiscoveryRequestJson(workspaceFolders)
			);
			const response = normalizeSemanticEndpointResponse(rawResponse);
			if (response?.supported) {
				return {
					source: 'semantic',
					groups: response.groups,
					message: `Helidon endpoint discovery is using Java semantic support (${countEndpoints(response.groups)} endpoint(s)).`,
				};
			}

			if (response?.supported === false) {
				const groups = sortEndpointGroups(await fallbackProvider());
				return {
					source: 'source-parser',
					groups,
					message:
						'Helidon endpoint discovery semantic provider reported unsupported; using source parsing fallback.',
				};
			}

			if (rawResponse !== undefined && rawResponse !== null) {
				const groups = sortEndpointGroups(await fallbackProvider());
				return {
					source: 'source-parser',
					groups,
					message:
						'Helidon endpoint discovery semantic provider returned an unexpected payload; using source parsing fallback.',
				};
			}
		} catch (error) {
			const groups = sortEndpointGroups(await fallbackProvider());
			return {
				source: 'source-parser',
				groups,
				message: `Helidon endpoint discovery semantic provider is unavailable (${errorMessage(error)}); using source parsing fallback.`,
			};
		}
	}

	const groups = sortEndpointGroups(await fallbackProvider());
	return {
		source: 'source-parser',
		groups,
		message: `Helidon endpoint discovery is using source parsing fallback (${countEndpoints(groups)} endpoint(s)).`,
	};
}

abstract class HelidonEndpointTreeItem extends vscode.TreeItem {
	abstract readonly key: string;
}

class HelidonEndpointGroupItem extends HelidonEndpointTreeItem {
	readonly key: string;
	readonly group: HelidonEndpointGroup;

	constructor(group: HelidonEndpointGroup) {
		super(group.className, vscode.TreeItemCollapsibleState.Expanded);
		this.key = `${group.relativePath}#${group.className}`;
		this.group = group;
		this.description = group.relativePath;
		this.tooltip = `${group.className}\n${group.relativePath}`;
		this.iconPath = new vscode.ThemeIcon('symbol-class');
		this.command = {
			command: 'helidon-vsc.openEndpoint',
			title: 'Open Helidon Resource',
			arguments: [group.uri, new vscode.Range(group.line, 0, group.line, 0)],
		};
	}
}

class HelidonEndpointItem extends HelidonEndpointTreeItem {
	readonly key: string;

	constructor(readonly endpoint: HelidonEndpoint) {
		super(`${endpoint.httpMethod} ${endpoint.path}`, vscode.TreeItemCollapsibleState.None);
		this.key = `${endpoint.relativePath}#${endpoint.className}#${endpoint.methodName}#${endpoint.line}`;
		this.description = `${endpoint.className}.${endpoint.methodName}()`;
		this.tooltip = `${endpoint.httpMethod} ${endpoint.path}\n${endpoint.relativePath}:${endpoint.line + 1}`;
		this.iconPath = new vscode.ThemeIcon('symbol-method');
		this.command = {
			command: 'helidon-vsc.openEndpoint',
			title: 'Open Helidon Endpoint',
			arguments: [endpoint.uri, new vscode.Range(endpoint.line, 0, endpoint.line, 0)],
		};
	}
}

export class HelidonEndpointsTreeDataProvider
	implements vscode.TreeDataProvider<HelidonEndpointTreeItem>
{
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<HelidonEndpointTreeItem | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	private cachedDiscovery: HelidonEndpointDiscoveryResult | undefined;
	private lastDiscoveryMessage: string | undefined;

	constructor(
		private readonly discoveryOptions: HelidonEndpointDiscoveryOptions & {
			logger?: HelidonEndpointDiscoveryLogger;
		} = {},
	) {}

	refresh(): void {
		this.cachedDiscovery = undefined;
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	getTreeItem(element: HelidonEndpointTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: HelidonEndpointTreeItem): Promise<HelidonEndpointTreeItem[]> {
		const groups = (await this.loadDiscovery()).groups;
		if (!element) {
			return groups.map((group) => new HelidonEndpointGroupItem(group));
		}

		if (element instanceof HelidonEndpointGroupItem) {
			return element.group.endpoints.map((endpoint) => new HelidonEndpointItem(endpoint));
		}

		return [];
	}

	async endpointCount(): Promise<number> {
		const groups = (await this.loadDiscovery()).groups;
		return groups.reduce((count, group) => count + group.endpoints.length, 0);
	}

	async endpointsForDocument(uri: vscode.Uri): Promise<HelidonEndpoint[]> {
		const groups = (await this.loadDiscovery()).groups;
		return groups.flatMap((group) => group.endpoints.filter((endpoint) => endpoint.uri.toString() === uri.toString()));
	}

	async discoverySource(): Promise<HelidonEndpointDiscoverySource> {
		return (await this.loadDiscovery()).source;
	}

	private async loadDiscovery(): Promise<HelidonEndpointDiscoveryResult> {
		if (!this.cachedDiscovery) {
			this.cachedDiscovery = await discoverHelidonEndpointGroups(this.discoveryOptions);
			const discovery = this.cachedDiscovery;
			if (this.discoveryOptions.logger && discovery.message !== this.lastDiscoveryMessage) {
				this.discoveryOptions.logger.appendLine(discovery.message);
				this.lastDiscoveryMessage = discovery.message;
			}
		}

		return this.cachedDiscovery;
	}
}

export class HelidonEndpointCodeLensProvider implements vscode.CodeLensProvider {
	constructor(private readonly endpointsProvider: HelidonEndpointsTreeDataProvider) {}

	async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		if (document.languageId !== 'java') {
			return [];
		}

		const endpoints = await this.endpointsProvider.endpointsForDocument(document.uri);
		return endpoints.map((endpoint) => {
			const range = new vscode.Range(endpoint.line, 0, endpoint.line, 0);
			return new vscode.CodeLens(range, {
				command: 'helidon-vsc.openEndpoint',
				title: `${endpoint.httpMethod} ${endpoint.path}`,
				arguments: [endpoint.uri, range],
			});
		});
	}
}

async function pathParameterReferenceAt(
	document: vscode.TextDocument,
	position: vscode.Position,
): Promise<{ name: string; range: vscode.Range } | undefined> {
	const reference = await findJavaPathParameterReference(document.getText(), document.offsetAt(position));
	if (!reference) {
		return undefined;
	}

	return {
		name: reference.value,
		range: new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end)),
	};
}

async function semanticPathParameterDefinitionLocations(
	document: vscode.TextDocument,
	position: vscode.Position,
	endpointsProvider: Pick<HelidonEndpointsTreeDataProvider, 'endpointsForDocument'>,
	symbolProvider: (uri: vscode.Uri) => Promise<readonly HelidonDocumentSymbol[]> = defaultDocumentSymbolProvider,
): Promise<vscode.Location[] | undefined> {
	const reference = findSemanticPathParameterReference(document.getText(), document.offsetAt(position));
	if (!reference) {
		return undefined;
	}

	const methodContext = javaMethodContextAtPosition(await symbolProvider(document.uri), position);
	if (!methodContext) {
		return undefined;
	}

	const locations = findPathParameterEndpointLocations(
		await endpointsProvider.endpointsForDocument(document.uri),
		reference.value,
		methodContext,
	);
	return locations.length > 0 ? locations : undefined;
}

export class HelidonPathParameterDefinitionProvider implements vscode.DefinitionProvider {
	constructor(private readonly endpointsProvider: HelidonEndpointsTreeDataProvider) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.Definition | undefined> {
		if (document.languageId !== 'java') {
			return undefined;
		}

		const semanticLocations = await semanticPathParameterDefinitionLocations(
			document,
			position,
			this.endpointsProvider,
		);
		if (semanticLocations && semanticLocations.length > 0) {
			return semanticLocations;
		}

		if ((await this.endpointsProvider.discoverySource()) === 'semantic') {
			return undefined;
		}

		const reference = await pathParameterReferenceAt(document, position);
		if (!reference) {
			return undefined;
		}

		const locations = (await this.endpointsProvider.endpointsForDocument(document.uri))
			.filter((endpoint) => endpoint.path.includes(`{${reference.name}}`))
			.map((endpoint) => new vscode.Location(endpoint.uri, new vscode.Range(endpoint.line, 0, endpoint.line, 0)));
		return locations.length > 0 ? locations : undefined;
	}
}
