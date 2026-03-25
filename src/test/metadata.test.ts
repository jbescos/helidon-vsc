import * as assert from 'assert';
import { parseHelidonConfigMetadata } from '../metadata';

suite('Metadata Parser Test Suite', () => {
	test('parser tolerates missing option types and flattens inherited Helidon config keys', () => {
		const metadata = parseHelidonConfigMetadata(
			JSON.stringify([
				{
					module: 'io.helidon.webserver',
					types: [
						{
							type: 'io.helidon.webserver.ListenerConfig',
							options: [
								{
									key: 'host',
									description: 'Host of the default socket',
									defaultValue: '0.0.0.0',
								},
								{
									key: 'port',
									type: 'java.lang.Integer',
									description: 'Port of the default socket',
									defaultValue: '0',
								},
							],
						},
						{
							type: 'io.helidon.webserver.WebServer',
							standalone: true,
							prefix: 'server',
							inherits: ['io.helidon.webserver.ListenerConfig'],
							options: [
								{
									key: 'shutdown-hook',
									type: 'java.lang.Boolean',
									description: 'Registers a JVM shutdown hook',
									defaultValue: 'true',
								},
							],
						},
					],
				},
			])
		);

		assert.ok(metadata.some((property) => property.key === 'server.host'));
		assert.ok(metadata.some((property) => property.key === 'server.port'));
		assert.ok(metadata.some((property) => property.key === 'server.shutdown-hook'));
	});

	test('parser emits synthetic indexed and map entry keys for nested config types', () => {
		const metadata = parseHelidonConfigMetadata(
			JSON.stringify([
				{
					module: 'io.helidon.example',
					types: [
						{
							type: 'example.LoggerConfig',
							options: [
								{
									key: 'name',
									type: 'java.lang.String',
									description: 'Logger name',
								},
							],
						},
						{
							type: 'example.RootConfig',
							standalone: true,
							prefix: 'example',
							options: [
								{
									key: 'loggers',
									type: 'example.LoggerConfig',
									kind: 'LIST',
									description: 'Logger list',
								},
								{
									key: 'labels',
									kind: 'MAP',
									method: 'example.RootConfig.Builder#labels(java.util.Map<java.lang.String, java.lang.String>)',
									description: 'Label map',
								},
							],
						},
					],
				},
			])
		);

		assert.ok(metadata.some((property) => property.key === 'example.loggers'));
		assert.ok(metadata.some((property) => property.key === 'example.loggers.0'));
		assert.ok(metadata.some((property) => property.key === 'example.loggers.0.name'));
		assert.ok(metadata.some((property) => property.key === 'example.labels.*'));
	});
});
