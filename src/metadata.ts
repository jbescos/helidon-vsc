export interface HelidonConfigProperty {
	key: string;
	type: string;
	defaultValue?: string;
	description: string;
	example?: string;
}

interface HelidonMetadataModule {
	module: string;
	types: HelidonMetadataType[];
}

interface HelidonMetadataType {
	type: string;
	standalone: boolean;
	prefix: string;
	inherits: string[];
	options: HelidonMetadataOption[];
}

interface HelidonMetadataOption {
	key: string;
	type: string;
	description: string;
	kind: 'VALUE' | 'LIST' | 'MAP';
	method?: string;
	deprecated?: boolean;
	defaultValue?: string;
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

	for (const option of metadataType.options) {
		const key = prefix ? `${prefix}.${option.key}` : option.key;
		const nestedType = metadataTypes.get(option.type);
		const isLeaf = !nestedType || option.kind === 'LIST' || option.kind === 'MAP' || option.type.startsWith('java.');

		if (isLeaf) {
			properties.push({
				key,
				type: option.kind === 'LIST' ? `list<${option.type}>` : option.type,
				defaultValue: option.defaultValue,
				description: option.description,
				example: option.defaultValue,
			});
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
		.filter((type) => type.standalone && type.prefix.length > 0)
		.flatMap((type) => flattenType(type, metadataTypes, type.prefix, new Set<string>()));
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
