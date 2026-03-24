import helidonConfigMetadata from './metadata/helidon-config-metadata.json';
import type { HelidonConfigProperty } from './helidonConfig';

export function loadHelidonConfigMetadata(): HelidonConfigProperty[] {
	return helidonConfigMetadata as HelidonConfigProperty[];
}
