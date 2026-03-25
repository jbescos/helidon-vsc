import * as vscode from 'vscode';
import {
	findJavaPathParameterReference,
	parseJavaSourceModel,
	type JavaAnnotationInfo,
	type JavaClassInfo,
	type JavaExpressionInfo,
	type JavaInvocationInfo,
	type JavaSourceModel,
} from './javaSource';

const JAVA_ENDPOINT_GLOB = '**/*.java';
const JAVA_ENDPOINT_EXCLUDE_GLOB = '**/{.git,.gradle,.idea,node_modules,target}/**';
const HTTP_METHOD_ANNOTATIONS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
const ROUTING_HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'] as const;

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

function firstStringArgument(
	argumentsList: readonly JavaExpressionInfo[],
): Extract<JavaExpressionInfo, { kind: 'string' }> | undefined {
	return argumentsList.find((argument): argument is Extract<JavaExpressionInfo, { kind: 'string' }> => argument.kind === 'string');
}

function firstMethodReferenceArgument(
	argumentsList: readonly JavaExpressionInfo[],
): Extract<JavaExpressionInfo, { kind: 'methodReference' }> | undefined {
	return argumentsList.find(
		(argument): argument is Extract<JavaExpressionInfo, { kind: 'methodReference' }> => argument.kind === 'methodReference'
	);
}

function hasLambdaArgument(argumentsList: readonly JavaExpressionInfo[]): boolean {
	return argumentsList.some((argument) => argument.kind === 'lambda');
}

function serviceRegistrationFromInvocation(
	invocation: JavaInvocationInfo,
	className: string,
): ParsedServiceRegistration | undefined {
	if (invocation.name !== 'register') {
		return undefined;
	}

	const service = invocation.arguments.find(
		(argument): argument is Extract<JavaExpressionInfo, { kind: 'newClass' }> => argument.kind === 'newClass'
	);
	if (!service) {
		return undefined;
	}

	return {
		className,
		serviceClassName: service.className,
		basePath: firstStringArgument(invocation.arguments)?.value ?? '/',
		line: invocation.line,
	};
}

function routeDefinitionFromInvocation(
	invocation: JavaInvocationInfo,
	className: string,
	ownerMethodName: string,
): PendingRouteDefinition | undefined {
	const invocationName = invocation.name.toLowerCase();
	const handler = firstMethodReferenceArgument(invocation.arguments);
	const path = firstStringArgument(invocation.arguments);

	if (ROUTING_HTTP_METHODS.includes(invocationName as typeof ROUTING_HTTP_METHODS[number])) {
		if (path) {
			return {
				className,
				httpMethod: invocationName.toUpperCase(),
				path: path.value,
				line: invocation.line,
				ownerMethodName,
				handlerMethodName: handler?.methodName,
			};
		}

		if (handler || hasLambdaArgument(invocation.arguments)) {
			return {
				className,
				httpMethod: invocationName.toUpperCase(),
				path: '/',
				line: invocation.line,
				ownerMethodName,
				handlerMethodName: handler?.methodName,
			};
		}

		return undefined;
	}

	if (invocationName !== 'anyof' || !path) {
		return undefined;
	}

	return {
		className,
		httpMethod: 'ANY_OF',
		path: path.value,
		line: invocation.line,
		ownerMethodName,
		handlerMethodName: handler?.methodName,
	};
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

function routingModelFromParsedSource(model: JavaSourceModel): ParsedJavaRoutingModel {
	const methodLinesByClass = new Map<string, Map<string, number>>();
	const routes: PendingRouteDefinition[] = [];
	const registrations: ParsedServiceRegistration[] = [];

	walkJavaClasses(model.classes, (classInfo) => {
		methodLinesByClass.set(
			classInfo.name,
			new Map(classInfo.methods.map((method) => [method.name, method.line]))
		);

		for (const method of classInfo.methods) {
			for (const invocation of method.invocations) {
				const route = routeDefinitionFromInvocation(invocation, classInfo.name, method.name);
				if (route) {
					routes.push(route);
				}

				const registration = serviceRegistrationFromInvocation(invocation, classInfo.name);
				if (registration) {
					registrations.push(registration);
				}
			}
		}
	});

	return {
		routes: routes.map((route) => {
			const methodLines = methodLinesByClass.get(route.className);
			const resolvedMethodName = route.handlerMethodName ?? route.ownerMethodName ?? `${route.httpMethod.toLowerCase()}Route`;
			return {
				className: route.className,
				methodName: resolvedMethodName,
				httpMethod: route.httpMethod,
				path: route.path,
				line: route.handlerMethodName ? methodLines?.get(route.handlerMethodName) ?? route.line : route.line,
			};
		}),
		registrations,
	};
}

export async function parseJavaJaxRsEndpoints(source: string): Promise<Omit<HelidonEndpoint, 'relativePath' | 'uri'>[]> {
	const model = await parseJavaSourceModel(source);
	return model ? jaxRsEndpointsFromModel(model) : [];
}

async function parseJavaRoutingModel(source: string): Promise<ParsedJavaRoutingModel> {
	const model = await parseJavaSourceModel(source);
	return model ? routingModelFromParsedSource(model) : { routes: [], registrations: [] };
}

export async function parseJavaHelidonRoutingEndpoints(source: string): Promise<ParsedRouteDefinition[]> {
	return (await parseJavaRoutingModel(source)).routes;
}

async function scanWorkspaceEndpoints(): Promise<HelidonEndpointGroup[]> {
	const files = await vscode.workspace.findFiles(JAVA_ENDPOINT_GLOB, JAVA_ENDPOINT_EXCLUDE_GLOB);
	const groupedByClass = new Map<string, HelidonEndpointGroup>();
	const routeDefinitionsByClass = new Map<string, HelidonEndpoint[]>();
	const registrations: Array<ParsedServiceRegistration & { uri: vscode.Uri }> = [];

	for (const file of files) {
		const source = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
		const relativePath = vscode.workspace.asRelativePath(file, false);
		const model = await parseJavaSourceModel(source);
		const jaxRsEndpoints = model ? jaxRsEndpointsFromModel(model) : [];
		const routingModel = model ? routingModelFromParsedSource(model) : { routes: [], registrations: [] };

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

export class HelidonPathParameterDefinitionProvider implements vscode.DefinitionProvider {
	constructor(private readonly endpointsProvider: HelidonEndpointsTreeDataProvider) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.Definition | undefined> {
		if (document.languageId !== 'java') {
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
