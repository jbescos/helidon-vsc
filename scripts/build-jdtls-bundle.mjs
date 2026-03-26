import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(repoRoot, 'jdtls-src');
const javaSourceRoot = path.join(sourceRoot, 'src', 'main', 'java');
const manifestPath = path.join(sourceRoot, 'MANIFEST.MF');
const pluginXmlPath = path.join(sourceRoot, 'plugin.xml');
const outputJarPath = path.join(repoRoot, 'bundles', 'io.helidon.vscode.jdt.jar');
const buildRoot = path.join(repoRoot, 'out', 'jdtls-bundle');
const classesRoot = path.join(buildRoot, 'classes');
const resourcesRoot = path.join(buildRoot, 'resources');
const generatedManifestPath = path.join(buildRoot, 'MANIFEST.MF');
const BUNDLE_VERSION_BASE = '0.0.1';
const BUNDLE_VERSION_PATTERN = /^Bundle-Version:\s*.+$/mu;

async function listJavaFiles(root) {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listJavaFiles(entryPath));
			continue;
		}

		if (entry.isFile() && entry.name.endsWith('.java')) {
			files.push(entryPath);
		}
	}

	return files.sort();
}

async function findRedHatJavaExtensionDir() {
	const candidateRoots = [
		process.env.VSCODE_EXTENSIONS,
		path.join(os.homedir(), '.vscode', 'extensions'),
		path.join(repoRoot, '.vscode-test', 'extensions'),
	].filter(Boolean);

	const candidates = [];
	for (const root of candidateRoots) {
		try {
			const entries = await fs.readdir(root, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || !entry.name.startsWith('redhat.java-')) {
					continue;
				}

				const extensionPath = path.join(root, entry.name);
				if (existsSync(path.join(extensionPath, 'server', 'plugins'))) {
					candidates.push(extensionPath);
				}
			}
		} catch {
			continue;
		}
	}

	candidates.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
	return candidates.at(-1);
}

async function listPluginJars(pluginsDir) {
	const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.jar'))
		.map((entry) => path.join(pluginsDir, entry.name))
		.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
}

async function buildBundleVersion(javaFiles) {
	const hash = createHash('sha256');
	const inputs = [manifestPath, pluginXmlPath, ...javaFiles];

	for (const inputPath of inputs) {
		hash.update(path.relative(repoRoot, inputPath));
		hash.update('\0');

		if (inputPath === manifestPath) {
			const manifestText = await fs.readFile(inputPath, 'utf8');
			hash.update(manifestText.replace(BUNDLE_VERSION_PATTERN, 'Bundle-Version:'));
		} else {
			hash.update(await fs.readFile(inputPath));
		}

		hash.update('\0');
	}

	return `${BUNDLE_VERSION_BASE}.v${hash.digest('hex').slice(0, 12)}`;
}

async function buildBundle() {
	const javaFiles = await listJavaFiles(javaSourceRoot);
	if (javaFiles.length === 0) {
		throw new Error(`No Java sources found under ${javaSourceRoot}.`);
	}

	const redHatJavaDir = await findRedHatJavaExtensionDir();
	if (!redHatJavaDir) {
		if (existsSync(outputJarPath)) {
			console.warn(`Skipping JDT bundle rebuild because redhat.java was not found. Reusing ${outputJarPath}.`);
			return;
		}

		throw new Error(
			'Unable to locate a local redhat.java installation to compile the Helidon JDT bundle. '
			+ 'Install the Red Hat Java extension or provide a prebuilt bundle.'
		);
	}

	const pluginsDir = path.join(redHatJavaDir, 'server', 'plugins');
	const pluginJars = await listPluginJars(pluginsDir);
	if (pluginJars.length === 0) {
		throw new Error(`No JDT plugin jars were found in ${pluginsDir}.`);
	}

	await fs.rm(buildRoot, { recursive: true, force: true });
	await fs.mkdir(classesRoot, { recursive: true });
	await fs.mkdir(resourcesRoot, { recursive: true });
	await fs.mkdir(path.dirname(outputJarPath), { recursive: true });
	await fs.copyFile(pluginXmlPath, path.join(resourcesRoot, 'plugin.xml'));

	const bundleVersion = await buildBundleVersion(javaFiles);
	const manifestText = await fs.readFile(manifestPath, 'utf8');
	await fs.writeFile(
		generatedManifestPath,
		manifestText.replace(BUNDLE_VERSION_PATTERN, `Bundle-Version: ${bundleVersion}`),
		'utf8'
	);

	const classpath = pluginJars.join(path.delimiter);
	execFileSync(
		'javac',
		['--release', '17', '-cp', classpath, '-d', classesRoot, ...javaFiles],
		{ stdio: 'inherit' }
	);

	execFileSync(
		'jar',
		[
			'--create',
			'--file',
			outputJarPath,
			'--manifest',
			generatedManifestPath,
			'-C',
			classesRoot,
			'.',
			'-C',
			resourcesRoot,
			'plugin.xml',
		],
		{ stdio: 'inherit' }
	);

	console.log(`Built ${path.relative(repoRoot, outputJarPath)} (${bundleVersion}) using ${redHatJavaDir}.`);
}

buildBundle().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
