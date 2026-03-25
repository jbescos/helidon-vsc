import * as vscode from 'vscode';

const JAVA_ENDPOINT_GLOB = '**/*.java';
const JAVA_ENDPOINT_EXCLUDE_GLOB = '**/{.git,.gradle,.idea,node_modules,target}/**';
const HTTP_METHOD_ANNOTATIONS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

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

interface ParsedRouteDefinition {
	className: string;
	methodName: string;
	httpMethod: string;
	path: string;
	line: number;
}

interface ParsedServiceRegistration {
	className: string;
	serviceClassName: string;
	basePath: string;
	line: number;
}

interface PendingRouteDefinition {
	className: string;
	httpMethod: string;
	path: string;
	line: number;
	ownerMethodName?: string;
	handlerMethodName?: string;
}

interface ParsedJavaRoutingModel {
	routes: ParsedRouteDefinition[];
	registrations: ParsedServiceRegistration[];
}

interface JavaClassContext {
	name: string;
	line: number;
	depth: number;
	methodLines: Map<string, number>;
}

interface JavaMethodContext {
	name: string;
	depth: number;
}

function stripLineComment(line: string): string {
	const commentIndex = line.indexOf('//');
	return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

function countOccurrences(text: string, character: string): number {
	return [...text].filter((current) => current === character).length;
}

function currentClassName(classStack: readonly JavaClassContext[]): string | undefined {
	return classStack[classStack.length - 1]?.name;
}

function currentMethodName(methodStack: readonly JavaMethodContext[]): string | undefined {
	return methodStack[methodStack.length - 1]?.name;
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

export function parseJavaJaxRsEndpoints(source: string): Omit<HelidonEndpoint, 'relativePath' | 'uri'>[] {
	const endpoints: Omit<HelidonEndpoint, 'relativePath' | 'uri'>[] = [];
	const lines = source.split(/\r?\n/u);
	const annotationBuffer: string[] = [];
	let currentClassName: string | undefined;
	let currentClassPath = '';

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = stripLineComment(lines[lineIndex]);
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
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

function parseJavaRoutingModel(source: string): ParsedJavaRoutingModel {
	const lines = source.split(/\r?\n/u);
	const classStack: JavaClassContext[] = [];
	const methodStack: JavaMethodContext[] = [];
	const classesByName = new Map<string, JavaClassContext>();
	const routes: PendingRouteDefinition[] = [];
	const registrations: ParsedServiceRegistration[] = [];
	let braceDepth = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		while (methodStack.length > 0 && braceDepth < methodStack[methodStack.length - 1].depth) {
			methodStack.pop();
		}
		while (classStack.length > 0 && braceDepth < classStack[classStack.length - 1].depth) {
			classStack.pop();
		}

		const line = stripLineComment(lines[lineIndex]);
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
			braceDepth += countOccurrences(line, '{') - countOccurrences(line, '}');
			continue;
		}

		const openBraces = countOccurrences(line, '{');
		const closeBraces = countOccurrences(line, '}');
		const nextDepth = braceDepth + openBraces - closeBraces;

		const classMatch = /\bclass\s+([A-Za-z_]\w*)\b/u.exec(trimmed);
		if (classMatch && openBraces > 0) {
			const classContext: JavaClassContext = {
				name: classMatch[1],
				line: lineIndex,
				depth: nextDepth,
				methodLines: new Map(),
			};
			classStack.push(classContext);
			classesByName.set(classContext.name, classContext);
		}

		const currentClass = classStack[classStack.length - 1];
		const methodMatch = currentClass && isMethodDeclaration(trimmed)
			? /\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws [^{]+)?\{?\s*$/u.exec(trimmed)
			: undefined;
		if (currentClass && methodMatch && openBraces > 0) {
			currentClass.methodLines.set(methodMatch[1], lineIndex);
			methodStack.push({
				name: methodMatch[1],
				depth: nextDepth,
			});
		}

		const className = currentClassName(classStack);
		if (className) {
			const route = parseHelidonRouteDefinition(trimmed, className, currentMethodName(methodStack), lineIndex);
			if (route) {
				routes.push(route);
			}

			const registration = parseServiceRegistration(trimmed, className, lineIndex);
			if (registration) {
				registrations.push(registration);
			}
		}

		braceDepth = nextDepth;
	}

	return {
		routes: routes.map((route) => {
			const classContext = classesByName.get(route.className);
			const resolvedMethodName = route.handlerMethodName ?? route.ownerMethodName ?? `${route.httpMethod.toLowerCase()}Route`;
			return {
				className: route.className,
				methodName: resolvedMethodName,
				httpMethod: route.httpMethod,
				path: route.path,
				line: route.handlerMethodName
					? classContext?.methodLines.get(route.handlerMethodName) ?? route.line
					: route.line,
			};
		}),
		registrations,
	};
}

export function parseJavaHelidonRoutingEndpoints(source: string): ParsedRouteDefinition[] {
	return parseJavaRoutingModel(source).routes;
}

function isMethodDeclaration(trimmedLine: string): boolean {
	if (!trimmedLine.includes('(') || trimmedLine.startsWith('@')) {
		return false;
	}

	return !/^(if|for|while|switch|catch|return|new)\b/u.test(trimmedLine);
}

function extractHandlerMethodName(line: string): string | undefined {
	return /::([A-Za-z_]\w*)/u.exec(line)?.[1];
}

function parseHelidonRouteDefinition(
	line: string,
	className: string,
	ownerMethodName: string | undefined,
	lineIndex: number,
): PendingRouteDefinition | undefined {
	const standardRoute = /\.(get|post|put|delete|patch|head|options|trace)\(\s*"([^"]*)"/iu.exec(line);
	if (standardRoute) {
		return {
			className,
			httpMethod: standardRoute[1].toUpperCase(),
			path: standardRoute[2],
			line: lineIndex,
			ownerMethodName,
			handlerMethodName: extractHandlerMethodName(line),
		};
	}

	const anyOfRoute = /\.anyOf\([^,]+,\s*"([^"]*)"/u.exec(line);
	if (anyOfRoute) {
		return {
			className,
			httpMethod: 'ANY_OF',
			path: anyOfRoute[1],
			line: lineIndex,
			ownerMethodName,
			handlerMethodName: extractHandlerMethodName(line),
		};
	}

	const handlerOnlyRoute = /\.(get|post|put|delete|patch|head|options|trace)\(\s*(this::[A-Za-z_]\w*|[A-Za-z_]\w*::[A-Za-z_]\w*|\([^)]*\)\s*->)/iu.exec(
		line
	);
	if (!handlerOnlyRoute) {
		return undefined;
	}

	return {
		className,
		httpMethod: handlerOnlyRoute[1].toUpperCase(),
		path: '/',
		line: lineIndex,
		ownerMethodName,
		handlerMethodName: extractHandlerMethodName(handlerOnlyRoute[2]),
	};
}

function parseServiceRegistration(
	line: string,
	className: string,
	lineIndex: number,
): ParsedServiceRegistration | undefined {
	const registrationWithPath = /\.register\(\s*"([^"]*)"\s*,\s*(?:.+,\s*)?new\s+([A-Za-z_]\w*)\s*\(/u.exec(line);
	if (registrationWithPath) {
		return {
			className,
			serviceClassName: registrationWithPath[2],
			basePath: registrationWithPath[1],
			line: lineIndex,
		};
	}

	const registrationWithoutPath = /\.register\(\s*new\s+([A-Za-z_]\w*)\s*\(/u.exec(line);
	if (!registrationWithoutPath) {
		return undefined;
	}

	return {
		className,
		serviceClassName: registrationWithoutPath[1],
		basePath: '/',
		line: lineIndex,
	};
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

async function scanWorkspaceEndpoints(): Promise<HelidonEndpointGroup[]> {
	const files = await vscode.workspace.findFiles(JAVA_ENDPOINT_GLOB, JAVA_ENDPOINT_EXCLUDE_GLOB);
	const groupedByClass = new Map<string, HelidonEndpointGroup>();
	const routeDefinitionsByClass = new Map<string, HelidonEndpoint[]>();
	const registrations: Array<ParsedServiceRegistration & { uri: vscode.Uri }> = [];

	for (const file of files) {
		const source = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
		const relativePath = vscode.workspace.asRelativePath(file, false);
		const jaxRsEndpoints = parseJavaJaxRsEndpoints(source);
		const routingModel = parseJavaRoutingModel(source);

		for (const endpoint of jaxRsEndpoints) {
			addEndpoint(groupedByClass, {
				...endpoint,
				relativePath,
				uri: file,
			});
		}

		for (const route of routingModel.routes) {
			const endpoints = routeDefinitionsByClass.get(route.className) ?? [];
			endpoints.push({
				...route,
				relativePath,
				uri: file,
			});
			routeDefinitionsByClass.set(route.className, endpoints);
		}

		for (const registration of routingModel.registrations) {
			registrations.push({ ...registration, uri: file });
		}
	}

	const registeredClasses = new Set(registrations.map((registration) => registration.serviceClassName));
	for (const registration of registrations) {
		const serviceEndpoints = routeDefinitionsByClass.get(registration.serviceClassName);
		if (!serviceEndpoints || serviceEndpoints.length === 0) {
			addEndpoint(groupedByClass, {
				className: registration.serviceClassName,
				methodName: 'register',
				httpMethod: 'REGISTER',
				path: joinEndpointPath(registration.basePath, '/'),
				relativePath: vscode.workspace.asRelativePath(registration.uri, false),
				uri: registration.uri,
				line: registration.line,
			});
			continue;
		}

		for (const endpoint of serviceEndpoints) {
			addEndpoint(groupedByClass, {
				...endpoint,
				path: joinEndpointPath(registration.basePath, endpoint.path),
			});
		}
	}

	for (const endpoints of routeDefinitionsByClass.values()) {
		for (const endpoint of endpoints) {
			if (!registeredClasses.has(endpoint.className)) {
				addEndpoint(groupedByClass, endpoint);
			}
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

	async endpointsForDocument(uri: vscode.Uri): Promise<HelidonEndpoint[]> {
		const groups = await this.loadGroups();
		return groups.flatMap((group) => group.endpoints.filter((endpoint) => endpoint.uri.toString() === uri.toString()));
	}

	private async loadGroups(): Promise<HelidonEndpointGroup[]> {
		if (!this.cachedGroups) {
			this.cachedGroups = await scanWorkspaceEndpoints();
		}

		return this.cachedGroups;
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

function pathParameterReferenceAt(
	document: vscode.TextDocument,
	position: vscode.Position,
): { name: string; range: vscode.Range } | undefined {
	const line = document.lineAt(position.line).text;
	const pattern = /(?:\.param|pathParameters\(\)\.(?:first|get))\(\s*"([^"]*)"/gu;
	for (const match of line.matchAll(pattern)) {
		const name = match[1];
		const matchIndex = match.index ?? -1;
		if (!name || matchIndex === -1) {
			continue;
		}

		const nameOffset = match[0].indexOf(name);
		const range = new vscode.Range(
			position.line,
			matchIndex + nameOffset,
			position.line,
			matchIndex + nameOffset + name.length
		);
		if (range.contains(position)) {
			return { name, range };
		}
	}

	return undefined;
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

		const reference = pathParameterReferenceAt(document, position);
		if (!reference) {
			return undefined;
		}

		const locations = (await this.endpointsProvider.endpointsForDocument(document.uri))
			.filter((endpoint) => endpoint.path.includes(`{${reference.name}}`))
			.map((endpoint) => new vscode.Location(endpoint.uri, new vscode.Range(endpoint.line, 0, endpoint.line, 0)));
		return locations.length > 0 ? locations : undefined;
	}
}
