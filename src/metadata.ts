export interface HelidonConfigProperty {
	key: string;
	type: string;
	kind?: 'VALUE' | 'LIST' | 'MAP';
	defaultValue?: string;
	description: string;
	example?: string;
	method?: string;
	deprecated?: boolean;
}

interface HelidonMetadataModule {
	module: string;
	types: HelidonMetadataType[];
}

interface HelidonMetadataType {
	type: string;
	standalone?: boolean;
	prefix?: string;
	inherits?: string[];
	options?: HelidonMetadataOption[];
}

interface HelidonMetadataOption {
	key: string;
	type?: string;
	description?: string;
	kind?: 'VALUE' | 'LIST' | 'MAP';
	method?: string;
	deprecated?: boolean;
	defaultValue?: string;
}

function isJavaLeafType(typeName: string): boolean {
	return typeName === 'unknown' || typeName.startsWith('java.');
}

function splitTopLevelGenericArguments(value: string): string[] {
	const parts: string[] = [];
	let current = '';
	let depth = 0;

	for (const character of value) {
		if (character === '<') {
			depth += 1;
			current += character;
			continue;
		}

		if (character === '>') {
			depth = Math.max(0, depth - 1);
			current += character;
			continue;
		}

		if (character === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}

		current += character;
	}

	if (current.trim().length > 0) {
		parts.push(current.trim());
	}

	return parts;
}

function genericTypeArguments(typeText: string): string[] {
	const start = typeText.indexOf('<');
	const end = typeText.lastIndexOf('>');
	if (start === -1 || end === -1 || end <= start + 1) {
		return [];
	}

	return splitTopLevelGenericArguments(typeText.slice(start + 1, end));
}

function valueTypeFromMethod(option: HelidonMetadataOption): string | undefined {
	if (!option.method) {
		return undefined;
	}

	const signatureStart = option.method.indexOf('(');
	const signatureEnd = option.method.lastIndexOf(')');
	if (signatureStart === -1 || signatureEnd === -1 || signatureEnd <= signatureStart + 1) {
		return undefined;
	}

	const parameters = splitTopLevelGenericArguments(option.method.slice(signatureStart + 1, signatureEnd));
	if (parameters.length === 0) {
		return undefined;
	}

	const firstParameter = parameters[0];
	if (option.kind === 'LIST') {
		return genericTypeArguments(firstParameter)[0];
	}

	if (option.kind === 'MAP') {
		return genericTypeArguments(firstParameter)[1];
	}

	return undefined;
}

function effectiveOptionValueType(option: HelidonMetadataOption): string {
	return option.type ?? valueTypeFromMethod(option) ?? 'unknown';
}

function addLeafProperty(
	properties: HelidonConfigProperty[],
	key: string,
	type: string,
	kind: 'VALUE' | 'LIST' | 'MAP',
	option: HelidonMetadataOption,
): void {
	properties.push({
		key,
		type,
		kind,
		defaultValue: option.defaultValue,
		description: option.description ?? '',
		example: option.defaultValue,
		method: option.method,
		deprecated: option.deprecated,
	});
}

function flattenType(
	metadataType: HelidonMetadataType,
	metadataTypes: ReadonlyMap<string, HelidonMetadataType>,
	prefix: string,
	visited: Set<string>,
): HelidonConfigProperty[] {
	if (visited.has(metadataType.type)) {
		return [];
	}

	visited.add(metadataType.type);
	const properties: HelidonConfigProperty[] = [];

	for (const inheritedTypeName of metadataType.inherits ?? []) {
		const inheritedType = metadataTypes.get(inheritedTypeName);
		if (!inheritedType) {
			continue;
		}

		properties.push(...flattenType(inheritedType, metadataTypes, prefix, new Set(visited)));
	}

	for (const option of metadataType.options ?? []) {
		if (!option.key) {
			continue;
		}

		const key = prefix ? `${prefix}.${option.key}` : option.key;
		const optionKind = option.kind ?? 'VALUE';
		const optionValueType = effectiveOptionValueType(option);
		const nestedType = metadataTypes.get(optionValueType);
		const isLeaf = !nestedType || isJavaLeafType(optionValueType);
		const optionType =
			optionKind === 'LIST'
				? `list<${optionValueType}>`
				: optionKind === 'MAP'
					? `map<${optionValueType}>`
					: optionValueType;

		addLeafProperty(properties, key, optionType, optionKind, option);

		if (isLeaf) {
			if (optionKind === 'LIST') {
				addLeafProperty(properties, `${key}.0`, optionValueType, 'VALUE', option);
			}
			if (optionKind === 'MAP') {
				addLeafProperty(properties, `${key}.*`, optionValueType, 'VALUE', option);
			}
			continue;
		}

		if (optionKind === 'LIST') {
			addLeafProperty(properties, `${key}.0`, optionValueType, 'VALUE', option);
			properties.push(...flattenType(nestedType, metadataTypes, `${key}.0`, new Set(visited)));
			continue;
		}

		if (optionKind === 'MAP') {
			addLeafProperty(properties, `${key}.*`, optionValueType, 'VALUE', option);
			properties.push(...flattenType(nestedType, metadataTypes, `${key}.*`, new Set(visited)));
			continue;
		}

		properties.push(...flattenType(nestedType, metadataTypes, key, new Set(visited)));
	}

	return properties;
}

function flattenMetadataModules(modules: readonly HelidonMetadataModule[]): HelidonConfigProperty[] {
	const metadataTypes = new Map(modules.flatMap((module) => module.types.map((type) => [type.type, type] as const)));
	return modules
		.flatMap((module) => module.types)
		.filter((type) => type.standalone === true && (type.prefix ?? '').length > 0)
		.flatMap((type) => flattenType(type, metadataTypes, type.prefix ?? '', new Set<string>()));
}

export function parseHelidonConfigMetadata(jsonText: string): HelidonConfigProperty[] {
	try {
		const modules = JSON.parse(jsonText) as HelidonMetadataModule[];
		if (!Array.isArray(modules)) {
			return [];
		}

		return flattenMetadataModules(modules);
	} catch {
		return [];
	}
}

export function mergeHelidonConfigMetadata(
	...metadataSources: ReadonlyArray<readonly HelidonConfigProperty[]>
): HelidonConfigProperty[] {
	const merged = new Map<string, HelidonConfigProperty>();
	for (const source of metadataSources) {
		for (const property of source) {
			merged.set(property.key, property);
		}
	}

	return [...merged.values()];
}
