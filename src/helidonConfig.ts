import * as vscode from 'vscode';

export interface HelidonConfigProperty {
	key: string;
	type: string;
	defaultValue?: string;
	description: string;
	example?: string;
}

export const HELIDON_CONFIG_PROPERTIES: HelidonConfigProperty[] = [
	{
		key: 'server.port',
		type: 'integer',
		defaultValue: '8080',
		description: 'Port where the Helidon web server listens for incoming HTTP requests.',
		example: '8080'
	},
	{
		key: 'server.host',
		type: 'string',
		defaultValue: '0.0.0.0',
		description: 'Host name or IP address to bind the Helidon server to.',
		example: '0.0.0.0'
	},
	{
		key: 'server.features.observe.enabled',
		type: 'boolean',
		defaultValue: 'false',
		description: 'Enables the Helidon observe endpoint support.',
		example: 'true'
	},
	{
		key: 'server.features.observe.endpoints.health.enabled',
		type: 'boolean',
		defaultValue: 'true',
		description: 'Enables the health endpoint under the observe feature.',
		example: 'true'
	},
	{
		key: 'server.features.observe.endpoints.metrics.enabled',
		type: 'boolean',
		defaultValue: 'true',
		description: 'Enables the metrics endpoint under the observe feature.',
		example: 'true'
	},
	{
		key: 'server.features.observe.endpoints.health.path',
		type: 'string',
		defaultValue: '/observe/health',
		description: 'HTTP path that exposes Helidon health checks.',
		example: '/observe/health'
	},
	{
		key: 'server.features.observe.endpoints.metrics.path',
		type: 'string',
		defaultValue: '/observe/metrics',
		description: 'HTTP path that exposes Helidon metrics.',
		example: '/observe/metrics'
	},
	{
		key: 'server.cors.enabled',
		type: 'boolean',
		defaultValue: 'false',
		description: 'Enables Cross-Origin Resource Sharing support for the Helidon server.',
		example: 'true'
	},
	{
		key: 'server.cors.cross-origin-0.path-pattern',
		type: 'string',
		description: 'Path pattern to which a named CORS configuration applies.',
		example: '/api/*'
	},
	{
		key: 'server.cors.cross-origin-0.allow-origins',
		type: 'list<string>',
		description: 'Comma-separated list of allowed origins for a named CORS configuration.',
		example: 'https://example.com,https://acme.test'
	},
	{
		key: 'logging.level',
		type: 'string',
		defaultValue: 'INFO',
		description: 'Default application log level.',
		example: 'DEBUG'
	},
	{
		key: 'logging.loggers.0.name',
		type: 'string',
		description: 'Logger name for a dedicated logger configuration entry.',
		example: 'io.helidon.webserver'
	},
	{
		key: 'logging.loggers.0.level',
		type: 'string',
		description: 'Log level for a dedicated logger configuration entry.',
		example: 'TRACE'
	},
	{
		key: 'security.enabled',
		type: 'boolean',
		defaultValue: 'true',
		description: 'Enables Helidon security integration.',
		example: 'true'
	},
	{
		key: 'security.providers.0.oidc.client-id',
		type: 'string',
		description: 'OIDC client identifier for a configured Helidon security provider.',
		example: 'helidon-service'
	},
	{
		key: 'security.providers.0.oidc.client-secret',
		type: 'string',
		description: 'OIDC client secret for a configured Helidon security provider.',
		example: 'changeit'
	},
	{
		key: 'security.providers.0.oidc.identity-uri',
		type: 'string',
		description: 'OIDC identity server base URI.',
		example: 'http://localhost:8180/realms/helidon'
	},
	{
		key: 'db.url',
		type: 'string',
		description: 'JDBC database connection URL used by the application.',
		example: 'jdbc:postgresql://localhost:5432/helidon'
	},
	{
		key: 'db.username',
		type: 'string',
		description: 'Database username.',
		example: 'appuser'
	},
	{
		key: 'db.password',
		type: 'string',
		description: 'Database password.',
		example: 'secret'
	},
	{
		key: 'metrics.enabled',
		type: 'boolean',
		defaultValue: 'true',
		description: 'Enables application metrics integration.',
		example: 'true'
	}
];

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
