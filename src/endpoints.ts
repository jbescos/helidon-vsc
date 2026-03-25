import * as vscode from 'vscode';

const JAVA_ENDPOINT_GLOB = '**/*.java';
const JAVA_ENDPOINT_EXCLUDE_GLOB = '**/{.git,.gradle,.idea,node_modules,target}/**';
const HTTP_METHOD_ANNOTATIONS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
const JAX_RS_PATH_ANNOTATION = '@Path';

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

export function parseJavaJaxRsEndpoints(source: string): Omit<HelidonEndpoint, 'relativePath' | 'uri'>[] {
	const endpoints: Omit<HelidonEndpoint, 'relativePath' | 'uri'>[] = [];
	const lines = source.split(/\r?\n/u);
	const annotationBuffer: string[] = [];
	let currentClassName: string | undefined;
	let currentClassPath = '';

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
			continue;
		}

		if (trimmed.startsWith('@')) {
			annotationBuffer.push(trimmed);
			continue;
		}

		const classMatch = /\bclass\s+([A-Za-z_]\w*)\b/u.exec(trimmed);
		if (classMatch) {
			currentClassName = classMatch[1];
			currentClassPath = extractPathAnnotation(annotationBuffer) ?? '';
			annotationBuffer.length = 0;
			continue;
		}

		if (!currentClassName) {
			annotationBuffer.length = 0;
			continue;
		}

		const httpMethod = extractHttpMethod(annotationBuffer);
		const methodMatch = /\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/u.exec(trimmed);
		if (httpMethod && methodMatch) {
			const methodName = methodMatch[1];
			const methodPath = extractPathAnnotation(annotationBuffer) ?? '';
			endpoints.push({
				className: currentClassName,
				methodName,
				httpMethod,
				path: joinEndpointPath(currentClassPath, methodPath),
				line: lineIndex,
			});
			annotationBuffer.length = 0;
			continue;
		}

		annotationBuffer.length = 0;
	}

	return endpoints;
}

function extractPathAnnotation(annotations: readonly string[]): string | undefined {
	for (const annotation of annotations) {
		const pathMatch = /@Path\(\s*"([^"]*)"\s*\)/u.exec(annotation);
		if (pathMatch) {
			return pathMatch[1];
		}
	}

	return undefined;
}

function extractHttpMethod(annotations: readonly string[]): string | undefined {
	for (const method of HTTP_METHOD_ANNOTATIONS) {
		if (annotations.some((annotation) => annotation.startsWith(`@${method}`))) {
			return method;
		}
	}

	return undefined;
}

function normalizeEndpointPathSegment(path: string): string {
	const trimmed = path.trim();
	if (trimmed.length === 0 || trimmed === '/') {
		return '';
	}

	return trimmed.replace(/^\/+/u, '').replace(/\/+$/u, '');
}

function joinEndpointPath(basePath: string, methodPath: string): string {
	const segments = [normalizeEndpointPathSegment(basePath), normalizeEndpointPathSegment(methodPath)].filter(
		(segment) => segment.length > 0
	);
	return `/${segments.join('/')}`;
}

async function scanWorkspaceEndpoints(): Promise<HelidonEndpointGroup[]> {
	const files = await vscode.workspace.findFiles(JAVA_ENDPOINT_GLOB, JAVA_ENDPOINT_EXCLUDE_GLOB);
	const groups: HelidonEndpointGroup[] = [];

	for (const file of files) {
		const source = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
		const endpoints = parseJavaJaxRsEndpoints(source);
		if (endpoints.length === 0) {
			continue;
		}

		const relativePath = vscode.workspace.asRelativePath(file, false);
		groups.push({
			className: endpoints[0].className,
			relativePath,
			uri: file,
			line: endpoints[0].line,
			endpoints: endpoints
				.map((endpoint) => ({
					...endpoint,
					relativePath,
					uri: file,
				}))
				.sort((left, right) =>
					left.path === right.path
						? left.httpMethod.localeCompare(right.httpMethod)
						: left.path.localeCompare(right.path)
				),
		});
	}

	return groups.sort((left, right) =>
		left.className === right.className
			? left.relativePath.localeCompare(right.relativePath)
			: left.className.localeCompare(right.className)
	);
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

	private cachedGroups: HelidonEndpointGroup[] | undefined;

	refresh(): void {
		this.cachedGroups = undefined;
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	getTreeItem(element: HelidonEndpointTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: HelidonEndpointTreeItem): Promise<HelidonEndpointTreeItem[]> {
		const groups = await this.loadGroups();
		if (!element) {
			return groups.map((group) => new HelidonEndpointGroupItem(group));
		}

		if (element instanceof HelidonEndpointGroupItem) {
			return element.group.endpoints.map((endpoint) => new HelidonEndpointItem(endpoint));
		}

		return [];
	}

	async endpointCount(): Promise<number> {
		const groups = await this.loadGroups();
		return groups.reduce((count, group) => count + group.endpoints.length, 0);
	}

	private async loadGroups(): Promise<HelidonEndpointGroup[]> {
		if (!this.cachedGroups) {
			this.cachedGroups = await scanWorkspaceEndpoints();
		}

		return this.cachedGroups;
	}
}
