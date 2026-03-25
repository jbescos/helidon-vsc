interface TokenType {
	name: string;
}

interface IToken {
	image: string;
	startOffset: number;
	startLine: number;
	endOffset: number;
	endLine: number;
	startColumn: number;
	endColumn: number;
	tokenType: TokenType;
}

interface NodeLocation {
	startOffset: number;
	startLine: number;
	startColumn: number;
	endOffset: number;
	endLine: number;
	endColumn: number;
}

interface CstNode {
	name: string;
	children: Record<string, Array<CstNode | IToken>>;
	location: NodeLocation;
}

export interface JavaAnnotationInfo {
	name: string;
	line: number;
	stringValue?: string;
}

export type JavaExpressionInfo =
	| { kind: 'string'; value: string; start: number; end: number }
	| { kind: 'methodReference'; methodName?: string }
	| { kind: 'lambda' }
	| { kind: 'newClass'; className: string }
	| { kind: 'identifier'; name: string }
	| { kind: 'unknown' };

export interface JavaInvocationInfo {
	name: string;
	line: number;
	methodTokenIndex: number;
	arguments: readonly JavaExpressionInfo[];
}

export interface JavaMethodInfo {
	name: string;
	line: number;
	annotations: readonly JavaAnnotationInfo[];
	invocations: readonly JavaInvocationInfo[];
}

export interface JavaClassInfo {
	name: string;
	line: number;
	annotations: readonly JavaAnnotationInfo[];
	methods: readonly JavaMethodInfo[];
	innerClasses: readonly JavaClassInfo[];
}

export interface JavaSourceModel {
	classes: readonly JavaClassInfo[];
	tokens: readonly IToken[];
}

export interface JavaStringReference {
	value: string;
	start: number;
	end: number;
}

type VariableBindings = Map<string, JavaExpressionInfo>;
interface JavaParserModule {
	lexAndParse(inputText: string): { cst: CstNode; tokens: IToken[] };
}

let javaParserPromise: Promise<JavaParserModule> | undefined;

async function getJavaParser(): Promise<JavaParserModule> {
	if (!javaParserPromise) {
		javaParserPromise = import('java-parser');
	}

	return javaParserPromise;
}

function unknownExpression(): JavaExpressionInfo {
	return { kind: 'unknown' };
}

function isCstNode(value: unknown): value is CstNode {
	return Boolean(value) && typeof value === 'object' && value !== null && 'name' in value && 'children' in value;
}

function isToken(value: unknown): value is IToken {
	return Boolean(value) && typeof value === 'object' && value !== null && 'image' in value && 'tokenType' in value;
}

function childNodes(node: CstNode | undefined, key: string): readonly CstNode[] {
	return ((node?.children[key] as CstNode[] | undefined) ?? []);
}

function childTokens(node: CstNode | undefined, key: string): readonly IToken[] {
	return ((node?.children[key] as IToken[] | undefined) ?? []);
}

function firstChildNode(node: CstNode | undefined, key: string): CstNode | undefined {
	return childNodes(node, key)[0];
}

function firstToken(node: CstNode | undefined, tokenName: string): IToken | undefined {
	return collectDescendantTokens(node, tokenName)[0];
}

function collectDescendantNodes(node: CstNode | undefined, nodeName: string, results: CstNode[] = []): CstNode[] {
	if (!node) {
		return results;
	}

	if (node.name === nodeName) {
		results.push(node);
	}

	for (const value of Object.values(node.children)) {
		for (const element of value) {
			if (isCstNode(element)) {
				collectDescendantNodes(element, nodeName, results);
			}
		}
	}

	return results;
}

function collectDescendantTokens(node: CstNode | undefined, tokenName: string, results: IToken[] = []): IToken[] {
	if (!node) {
		return results;
	}

	for (const value of Object.values(node.children)) {
		for (const element of value) {
			if (isToken(element) && element.tokenType.name === tokenName) {
				results.push(element);
				continue;
			}

			if (isCstNode(element)) {
				collectDescendantTokens(element, tokenName, results);
			}
		}
	}

	return results;
}

function decodeJavaStringLiteral(image: string): string {
	if (image.length < 2 || image[0] !== '"' || image[image.length - 1] !== '"') {
		return image;
	}

	let result = '';
	const text = image.slice(1, -1);
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character !== '\\') {
			result += character;
			continue;
		}

		index += 1;
		const escape = text[index];
		if (escape === undefined) {
			result += '\\';
			break;
		}

		if (escape === 'u') {
			while (text[index + 1] === 'u') {
				index += 1;
			}

			let hex = '';
			for (let count = 0; count < 4 && index + 1 < text.length; count += 1) {
				index += 1;
				hex += text[index] ?? '';
			}

			const codePoint = Number.parseInt(hex, 16);
			result += Number.isNaN(codePoint) ? hex : String.fromCharCode(codePoint);
			continue;
		}

		switch (escape) {
			case 'b':
				result += '\b';
				break;
			case 'f':
				result += '\f';
				break;
			case 'n':
				result += '\n';
				break;
			case 'r':
				result += '\r';
				break;
			case 't':
				result += '\t';
				break;
			case '"':
				result += '"';
				break;
			case '\'':
				result += '\'';
				break;
			case '\\':
				result += '\\';
				break;
			default:
				result += escape;
				break;
		}
	}

	return result;
}

function extractQualifiedName(node: CstNode | undefined): string {
	return collectDescendantTokens(node, 'Identifier')
		.map((token) => token.image)
		.join('.');
}

function extractLastIdentifier(node: CstNode | undefined): string | undefined {
	const identifiers = collectDescendantTokens(node, 'Identifier');
	return identifiers[identifiers.length - 1]?.image;
}

function extractStringLiteral(node: CstNode | undefined): JavaExpressionInfo | undefined {
	const token = firstToken(node, 'StringLiteral');
	if (!token) {
		return undefined;
	}

	return {
		kind: 'string',
		value: decodeJavaStringLiteral(token.image),
		start: token.startOffset + 1,
		end: token.endOffset,
	};
}

function extractAnnotation(annotation: CstNode): JavaAnnotationInfo | undefined {
	const name = extractQualifiedName(firstChildNode(annotation, 'typeName'));
	if (!name) {
		return undefined;
	}

	const stringValue = extractStringLiteral(annotation);
	return {
		name,
		line: annotation.location.startLine - 1,
		stringValue: stringValue?.kind === 'string' ? stringValue.value : undefined,
	};
}

function extractAnnotations(modifiers: readonly CstNode[]): JavaAnnotationInfo[] {
	const annotations: JavaAnnotationInfo[] = [];
	for (const modifier of modifiers) {
		for (const annotation of childNodes(modifier, 'annotation')) {
			const parsed = extractAnnotation(annotation);
			if (parsed) {
				annotations.push(parsed);
			}
		}
	}

	return annotations;
}

function resolveNewExpression(node: CstNode | undefined): JavaExpressionInfo {
	const className = extractLastIdentifier(firstChildNode(node, 'unqualifiedClassInstanceCreationExpression'));
	if (!className) {
		return unknownExpression();
	}

	return { kind: 'newClass', className };
}

function resolvePrimary(node: CstNode, bindings: ReadonlyMap<string, JavaExpressionInfo>): JavaExpressionInfo {
	for (const suffix of childNodes(node, 'primarySuffix')) {
		const methodReferenceSuffix = firstChildNode(suffix, 'methodReferenceSuffix');
		if (methodReferenceSuffix) {
			return {
				kind: 'methodReference',
				methodName: childTokens(methodReferenceSuffix, 'Identifier')[0]?.image,
			};
		}

		if (
			firstChildNode(suffix, 'methodInvocationSuffix') ||
			firstChildNode(suffix, 'arrayAccessSuffix') ||
			firstChildNode(suffix, 'classLiteralSuffix')
		) {
			return unknownExpression();
		}
	}

	const prefix = firstChildNode(node, 'primaryPrefix');
	if (!prefix) {
		return unknownExpression();
	}

	const literal = firstChildNode(prefix, 'literal');
	if (literal) {
		return extractStringLiteral(literal) ?? unknownExpression();
	}

	if (childTokens(prefix, 'This').length > 0) {
		const referencedField = childTokens(node, 'Identifier').slice(-1)[0]?.image;
		if (!referencedField) {
			return { kind: 'identifier', name: 'this' };
		}

		return bindings.get(referencedField) ?? { kind: 'identifier', name: referencedField };
	}

	const parenthesized = firstChildNode(prefix, 'parenthesisExpression');
	if (parenthesized) {
		const expression = firstChildNode(parenthesized, 'expression');
		return expression ? resolveExpression(expression, bindings) : unknownExpression();
	}

	const newExpression = firstChildNode(prefix, 'newExpression');
	if (newExpression) {
		return resolveNewExpression(newExpression);
	}

	const reference = firstChildNode(prefix, 'fqnOrRefType');
	if (reference) {
		const name = extractLastIdentifier(reference);
		if (!name) {
			return unknownExpression();
		}

		return bindings.get(name) ?? { kind: 'identifier', name };
	}

	return unknownExpression();
}

function resolveUnaryExpression(node: CstNode | undefined, bindings: ReadonlyMap<string, JavaExpressionInfo>): JavaExpressionInfo {
	if (!node) {
		return unknownExpression();
	}

	if (childTokens(node, 'UnaryPrefixOperator').length > 0 || childTokens(node, 'UnarySuffixOperator').length > 0) {
		return unknownExpression();
	}

	const primary = firstChildNode(node, 'primary');
	return primary ? resolvePrimary(primary, bindings) : unknownExpression();
}

function resolveExpression(node: CstNode | undefined, bindings: ReadonlyMap<string, JavaExpressionInfo>): JavaExpressionInfo {
	if (!node) {
		return unknownExpression();
	}

	if (firstChildNode(node, 'lambdaExpression')) {
		return { kind: 'lambda' };
	}

	const conditionalExpression = firstChildNode(node, 'conditionalExpression');
	if (!conditionalExpression || childTokens(conditionalExpression, 'QuestionMark').length > 0) {
		return unknownExpression();
	}

	const binaryExpression = firstChildNode(conditionalExpression, 'binaryExpression');
	if (!binaryExpression) {
		return unknownExpression();
	}

	if (
		childTokens(binaryExpression, 'AssignmentOperator').length > 0 ||
		childTokens(binaryExpression, 'BinaryOperator').length > 0 ||
		childTokens(binaryExpression, 'Instanceof').length > 0
	) {
		return unknownExpression();
	}

	const unaryExpressions = childNodes(binaryExpression, 'unaryExpression');
	if (unaryExpressions.length !== 1) {
		return unknownExpression();
	}

	return resolveUnaryExpression(unaryExpressions[0], bindings);
}

function bindVariableDeclaration(node: CstNode, bindings: VariableBindings): void {
	for (const declarator of childNodes(firstChildNode(node, 'variableDeclaratorList'), 'variableDeclarator')) {
		const name = childTokens(firstChildNode(declarator, 'variableDeclaratorId'), 'Identifier')[0]?.image;
		if (!name) {
			continue;
		}

		const initializer = firstChildNode(declarator, 'variableInitializer');
		if (!initializer) {
			continue;
		}

		bindings.set(name, resolveExpression(firstChildNode(initializer, 'expression'), bindings));
	}
}

function methodInvocationInfo(
	node: CstNode,
	tokens: readonly IToken[],
	tokenIndexByOffset: ReadonlyMap<number, number>,
	bindings: ReadonlyMap<string, JavaExpressionInfo>,
): JavaInvocationInfo | undefined {
	const openingParen = childTokens(node, 'LBrace')[0];
	if (!openingParen) {
		return undefined;
	}

	const openingParenIndex = tokenIndexByOffset.get(openingParen.startOffset);
	if (openingParenIndex === undefined || openingParenIndex === 0) {
		return undefined;
	}

	const methodTokenIndex = openingParenIndex - 1;
	const methodNameToken = tokens[methodTokenIndex];
	if (!methodNameToken || methodNameToken.tokenType.name !== 'Identifier') {
		return undefined;
	}

	const argumentList = firstChildNode(node, 'argumentList');
	const expressions = childNodes(argumentList, 'expression');

	return {
		name: methodNameToken.image,
		line: methodNameToken.startLine - 1,
		methodTokenIndex,
		arguments: expressions.map((expression) => resolveExpression(expression, bindings)),
	};
}

function collectFieldBindings(body: CstNode | undefined): VariableBindings {
	const bindings: VariableBindings = new Map();
	for (const declaration of childNodes(body, 'classBodyDeclaration')) {
		const member = firstChildNode(declaration, 'classMemberDeclaration');
		const fieldDeclaration = firstChildNode(member, 'fieldDeclaration');
		if (!fieldDeclaration) {
			continue;
		}

		bindVariableDeclaration(fieldDeclaration, bindings);
	}

	return bindings;
}

function collectMethodInvocations(
	body: CstNode | undefined,
	tokens: readonly IToken[],
	tokenIndexByOffset: ReadonlyMap<number, number>,
	initialBindings: ReadonlyMap<string, JavaExpressionInfo>,
): JavaInvocationInfo[] {
	if (!body) {
		return [];
	}

	const bindings: VariableBindings = new Map(initialBindings);
	const orderedNodes = [
		...collectDescendantNodes(body, 'localVariableDeclaration').map((node) => ({ kind: 'local' as const, node })),
		...collectDescendantNodes(body, 'methodInvocationSuffix').map((node) => ({ kind: 'invocation' as const, node })),
	].sort((left, right) => left.node.location.startOffset - right.node.location.startOffset);

	const invocations: JavaInvocationInfo[] = [];
	for (const entry of orderedNodes) {
		if (entry.kind === 'local') {
			bindVariableDeclaration(entry.node, bindings);
			continue;
		}

		const invocation = methodInvocationInfo(entry.node, tokens, tokenIndexByOffset, bindings);
		if (invocation) {
			invocations.push(invocation);
		}
	}

	return invocations;
}

function extractMethodDeclaration(
	node: CstNode,
	tokens: readonly IToken[],
	tokenIndexByOffset: ReadonlyMap<number, number>,
	fieldBindings: ReadonlyMap<string, JavaExpressionInfo>,
): JavaMethodInfo | undefined {
	const methodHeader = firstChildNode(node, 'methodHeader');
	const methodDeclarator = firstChildNode(methodHeader, 'methodDeclarator');
	const methodNameToken = childTokens(methodDeclarator, 'Identifier')[0];
	if (!methodNameToken) {
		return undefined;
	}

	const methodBody = firstChildNode(firstChildNode(node, 'methodBody'), 'block');
	return {
		name: methodNameToken.image,
		line: methodNameToken.startLine - 1,
		annotations: extractAnnotations(childNodes(node, 'methodModifier')),
		invocations: collectMethodInvocations(methodBody, tokens, tokenIndexByOffset, fieldBindings),
	};
}

function extractClassDeclaration(
	node: CstNode,
	tokens: readonly IToken[],
	tokenIndexByOffset: ReadonlyMap<number, number>,
): JavaClassInfo | undefined {
	const normalClassDeclaration = firstChildNode(node, 'normalClassDeclaration');
	if (!normalClassDeclaration) {
		return undefined;
	}

	const nameToken = childTokens(firstChildNode(normalClassDeclaration, 'typeIdentifier'), 'Identifier')[0];
	if (!nameToken) {
		return undefined;
	}

	const classBody = firstChildNode(normalClassDeclaration, 'classBody');
	const fieldBindings = collectFieldBindings(classBody);
	const methods: JavaMethodInfo[] = [];
	const innerClasses: JavaClassInfo[] = [];

	for (const declaration of childNodes(classBody, 'classBodyDeclaration')) {
		const member = firstChildNode(declaration, 'classMemberDeclaration');
		if (!member) {
			continue;
		}

		const methodDeclaration = firstChildNode(member, 'methodDeclaration');
		if (methodDeclaration) {
			const method = extractMethodDeclaration(methodDeclaration, tokens, tokenIndexByOffset, fieldBindings);
			if (method) {
				methods.push(method);
			}
			continue;
		}

		const innerClassDeclaration = firstChildNode(member, 'classDeclaration');
		if (innerClassDeclaration) {
			const innerClass = extractClassDeclaration(innerClassDeclaration, tokens, tokenIndexByOffset);
			if (innerClass) {
				innerClasses.push(innerClass);
			}
		}
	}

	return {
		name: nameToken.image,
		line: nameToken.startLine - 1,
		annotations: extractAnnotations(childNodes(node, 'classModifier')),
		methods,
		innerClasses,
	};
}

function collectTopLevelClasses(
	root: CstNode,
	tokens: readonly IToken[],
	tokenIndexByOffset: ReadonlyMap<number, number>,
): JavaClassInfo[] {
	const classes: JavaClassInfo[] = [];
	for (const compilationUnit of childNodes(root, 'ordinaryCompilationUnit')) {
		for (const typeDeclaration of childNodes(compilationUnit, 'typeDeclaration')) {
			const classDeclaration = firstChildNode(typeDeclaration, 'classDeclaration');
			if (!classDeclaration) {
				continue;
			}

			const parsed = extractClassDeclaration(classDeclaration, tokens, tokenIndexByOffset);
			if (parsed) {
				classes.push(parsed);
			}
		}
	}

	return classes;
}

function walkClasses(classes: readonly JavaClassInfo[], consumer: (classInfo: JavaClassInfo) => void): void {
	for (const classInfo of classes) {
		consumer(classInfo);
		walkClasses(classInfo.innerClasses, consumer);
	}
}

function hasPathParametersReceiver(tokens: readonly IToken[], methodTokenIndex: number): boolean {
	if (methodTokenIndex < 4) {
		return false;
	}

	const receiverDot = tokens[methodTokenIndex - 1];
	const closingParen = tokens[methodTokenIndex - 2];
	const openingParen = tokens[methodTokenIndex - 3];
	const receiverName = tokens[methodTokenIndex - 4];
	return receiverDot?.tokenType.name === 'Dot'
		&& closingParen?.tokenType.name === 'RBrace'
		&& openingParen?.tokenType.name === 'LBrace'
		&& receiverName?.tokenType.name === 'Identifier'
		&& receiverName.image === 'pathParameters';
}

export async function parseJavaSourceModel(source: string): Promise<JavaSourceModel | undefined> {
	try {
		const { lexAndParse } = await getJavaParser();
		const { cst, tokens } = lexAndParse(source);
		const tokenIndexByOffset = new Map<number, number>();
		tokens.forEach((token, index) => {
			tokenIndexByOffset.set(token.startOffset, index);
		});

		return {
			classes: collectTopLevelClasses(cst, tokens, tokenIndexByOffset),
			tokens,
		};
	} catch {
		return undefined;
	}
}

export async function findJavaPathParameterReference(
	source: string,
	offset: number,
): Promise<JavaStringReference | undefined> {
	const model = await parseJavaSourceModel(source);
	if (!model) {
		return undefined;
	}

	let result: JavaStringReference | undefined;
	walkClasses(model.classes, (classInfo) => {
		if (result) {
			return;
		}

		for (const method of classInfo.methods) {
			for (const invocation of method.invocations) {
				const matchesInvocation = invocation.name === 'param'
					|| ((invocation.name === 'first' || invocation.name === 'get')
						&& hasPathParametersReceiver(model.tokens, invocation.methodTokenIndex));
				if (!matchesInvocation) {
					continue;
				}

				const matchingArgument = invocation.arguments.find(
					(argument): argument is Extract<JavaExpressionInfo, { kind: 'string' }> =>
						argument.kind === 'string' && argument.start <= offset && offset <= argument.end
				);
				if (matchingArgument) {
					result = {
						value: matchingArgument.value,
						start: matchingArgument.start,
						end: matchingArgument.end,
					};
					return;
				}
			}
		}
	});

	return result;
}
