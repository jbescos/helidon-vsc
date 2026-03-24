import helidonConfigMetadata from './metadata/helidon-config-metadata.json';
import type { HelidonConfigProperty } from './helidonConfig';

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

const metadataModules = helidonConfigMetadata as HelidonMetadataModule[];
const metadataTypes = new Map(metadataModules.flatMap((module) => module.types.map((type) => [type.type, type] as const)));

function flattenType(
	metadataType: HelidonMetadataType,
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

		properties.push(...flattenType(nestedType, key, new Set(visited)));
	}

	return properties;
}

export function loadHelidonConfigMetadata(): HelidonConfigProperty[] {
	return metadataModules
		.flatMap((module) => module.types)
		.filter((type) => type.standalone && type.prefix.length > 0)
		.flatMap((type) => flattenType(type, type.prefix, new Set<string>()));
}
