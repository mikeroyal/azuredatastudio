/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as nodeurl from 'url';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';

import { assign } from 'vs/base/common/objects';
import { endsWith } from 'vs/base/common/strings';
import { IExtHostWorkspaceProvider } from 'vs/workbench/api/common/extHostWorkspace';
import { ExtHostConfigProvider } from 'vs/workbench/api/common/extHostConfiguration';
import { ProxyAgent } from 'vscode-proxy-agent';
import { MainThreadTelemetryShape } from 'vs/workbench/api/common/extHost.protocol';
import { ExtHostLogService } from 'vs/workbench/api/common/extHostLogService';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { ExtHostExtensionService } from 'vs/workbench/api/node/extHostExtensionService';
import { URI } from 'vs/base/common/uri';
import { promisify } from 'util';

interface ConnectionResult {
	proxy: string;
	connection: string;
	code: string;
	count: number;
}

export function connectProxyResolver(
	extHostWorkspace: IExtHostWorkspaceProvider,
	configProvider: ExtHostConfigProvider,
	extensionService: ExtHostExtensionService,
	extHostLogService: ExtHostLogService,
	mainThreadTelemetry: MainThreadTelemetryShape
) {
	const resolveProxy = setupProxyResolution(extHostWorkspace, configProvider, extHostLogService, mainThreadTelemetry);
	const lookup = createPatchedModules(configProvider, resolveProxy);
	return configureModuleLoading(extensionService, lookup);
}

const maxCacheEntries = 5000; // Cache can grow twice that much due to 'oldCache'.

function setupProxyResolution(
	extHostWorkspace: IExtHostWorkspaceProvider,
	configProvider: ExtHostConfigProvider,
	extHostLogService: ExtHostLogService,
	mainThreadTelemetry: MainThreadTelemetryShape
) {
	const env = process.env;

	let settingsProxy = proxyFromConfigURL(configProvider.getConfiguration('http')
		.get<string>('proxy'));
	configProvider.onDidChangeConfiguration(e => {
		settingsProxy = proxyFromConfigURL(configProvider.getConfiguration('http')
			.get<string>('proxy'));
	});
	let envProxy = proxyFromConfigURL(env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY); // Not standardized.

	let envNoProxy = noProxyFromEnv(env.no_proxy || env.NO_PROXY); // Not standardized.

	let cacheRolls = 0;
	let oldCache = new Map<string, string>();
	let cache = new Map<string, string>();
	function getCacheKey(url: nodeurl.UrlWithStringQuery) {
		// Expecting proxies to usually be the same per scheme://host:port. Assuming that for performance.
		return nodeurl.format({ ...url, ...{ pathname: undefined, search: undefined, hash: undefined } });
	}
	function getCachedProxy(key: string) {
		let proxy = cache.get(key);
		if (proxy) {
			return proxy;
		}
		proxy = oldCache.get(key);
		if (proxy) {
			oldCache.delete(key);
			cacheProxy(key, proxy);
		}
		return proxy;
	}
	function cacheProxy(key: string, proxy: string) {
		cache.set(key, proxy);
		if (cache.size >= maxCacheEntries) {
			oldCache = cache;
			cache = new Map();
			cacheRolls++;
			extHostLogService.trace('ProxyResolver#cacheProxy cacheRolls', cacheRolls);
		}
	}

	let timeout: NodeJS.Timer | undefined;
	let count = 0;
	let duration = 0;
	let errorCount = 0;
	let cacheCount = 0;
	let envCount = 0;
	let settingsCount = 0;
	let localhostCount = 0;
	let envNoProxyCount = 0;
	let results: ConnectionResult[] = [];
	function logEvent() {
		timeout = undefined;
		/* __GDPR__
			"resolveProxy" : {
				"count": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"duration": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"errorCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"cacheCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"cacheSize": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"cacheRolls": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"envCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"settingsCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"localhostCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"envNoProxyCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"results": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" }
			}
		*/
		mainThreadTelemetry.$publicLog('resolveProxy', { count, duration, errorCount, cacheCount, cacheSize: cache.size, cacheRolls, envCount, settingsCount, localhostCount, envNoProxyCount, results });
		count = duration = errorCount = cacheCount = envCount = settingsCount = localhostCount = envNoProxyCount = 0;
		results = [];
	}

	function resolveProxy(flags: { useProxySettings: boolean, useSystemCertificates: boolean }, req: http.ClientRequest, opts: http.RequestOptions, url: string, callback: (proxy?: string) => void) {
		if (!timeout) {
			timeout = setTimeout(logEvent, 10 * 60 * 1000);
		}

		useSystemCertificates(extHostLogService, flags.useSystemCertificates, opts, () => {
			useProxySettings(flags.useProxySettings, req, opts, url, callback);
		});
	}

	function useProxySettings(useProxySettings: boolean, req: http.ClientRequest, opts: http.RequestOptions, url: string, callback: (proxy?: string) => void) {

		if (!useProxySettings) {
			callback('DIRECT');
			return;
		}

		const parsedUrl = nodeurl.parse(url); // Coming from Node's URL, sticking with that.

		const hostname = parsedUrl.hostname;
		if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '::ffff:127.0.0.1') {
			localhostCount++;
			callback('DIRECT');
			extHostLogService.trace('ProxyResolver#resolveProxy localhost', url, 'DIRECT');
			return;
		}

		if (typeof hostname === 'string' && envNoProxy(hostname, String(parsedUrl.port || (<any>opts.agent).defaultPort))) {
			envNoProxyCount++;
			callback('DIRECT');
			extHostLogService.trace('ProxyResolver#resolveProxy envNoProxy', url, 'DIRECT');
			return;
		}

		if (settingsProxy) {
			settingsCount++;
			callback(settingsProxy);
			extHostLogService.trace('ProxyResolver#resolveProxy settings', url, settingsProxy);
			return;
		}

		if (envProxy) {
			envCount++;
			callback(envProxy);
			extHostLogService.trace('ProxyResolver#resolveProxy env', url, envProxy);
			return;
		}

		const key = getCacheKey(parsedUrl);
		const proxy = getCachedProxy(key);
		if (proxy) {
			cacheCount++;
			collectResult(results, proxy, parsedUrl.protocol === 'https:' ? 'HTTPS' : 'HTTP', req);
			callback(proxy);
			extHostLogService.trace('ProxyResolver#resolveProxy cached', url, proxy);
			return;
		}

		const start = Date.now();
		extHostWorkspace.resolveProxy(url) // Use full URL to ensure it is an actually used one.
			.then(proxy => {
				if (proxy) {
					cacheProxy(key, proxy);
					collectResult(results, proxy, parsedUrl.protocol === 'https:' ? 'HTTPS' : 'HTTP', req);
				}
				callback(proxy);
				extHostLogService.debug('ProxyResolver#resolveProxy', url, proxy);
			}).then(() => {
				count++;
				duration = Date.now() - start + duration;
			}, err => {
				errorCount++;
				callback();
				extHostLogService.error('ProxyResolver#resolveProxy', toErrorMessage(err));
			});
	}

	return resolveProxy;
}

function collectResult(results: ConnectionResult[], resolveProxy: string, connection: string, req: http.ClientRequest) {
	const proxy = resolveProxy ? String(resolveProxy).trim().split(/\s+/, 1)[0] : 'EMPTY';
	req.on('response', res => {
		const code = `HTTP_${res.statusCode}`;
		const result = findOrCreateResult(results, proxy, connection, code);
		result.count++;
	});
	req.on('error', err => {
		const code = err && typeof (<any>err).code === 'string' && (<any>err).code || 'UNKNOWN_ERROR';
		const result = findOrCreateResult(results, proxy, connection, code);
		result.count++;
	});
}

function findOrCreateResult(results: ConnectionResult[], proxy: string, connection: string, code: string): ConnectionResult {
	for (const result of results) {
		if (result.proxy === proxy && result.connection === connection && result.code === code) {
			return result;
		}
	}
	const result = { proxy, connection, code, count: 0 };
	results.push(result);
	return result;
}

function proxyFromConfigURL(configURL: string | undefined) {
	const url = (configURL || '').trim();
	const i = url.indexOf('://');
	if (i === -1) {
		return undefined;
	}
	const scheme = url.substr(0, i).toLowerCase();
	const proxy = url.substr(i + 3);
	if (scheme === 'http') {
		return 'PROXY ' + proxy;
	} else if (scheme === 'https') {
		return 'HTTPS ' + proxy;
	} else if (scheme === 'socks') {
		return 'SOCKS ' + proxy;
	}
	return undefined;
}

function noProxyFromEnv(envValue?: string) {
	const value = (envValue || '')
		.trim()
		.toLowerCase();

	if (value === '*') {
		return () => true;
	}

	const filters = value
		.split(',')
		.map(s => s.trim().split(':', 2))
		.map(([name, port]) => ({ name, port }))
		.filter(filter => !!filter.name)
		.map(({ name, port }) => {
			const domain = name[0] === '.' ? name : `.${name}`;
			return { domain, port };
		});
	if (!filters.length) {
		return () => false;
	}
	return (hostname: string, port: string) => filters.some(({ domain, port: filterPort }) => {
		return endsWith(`.${hostname.toLowerCase()}`, domain) && (!filterPort || port === filterPort);
	});
}

function createPatchedModules(configProvider: ExtHostConfigProvider, resolveProxy: ReturnType<typeof setupProxyResolution>) {
	const proxySetting = {
		config: configProvider.getConfiguration('http')
			.get<string>('proxySupport') || 'off'
	};
	configProvider.onDidChangeConfiguration(e => {
		proxySetting.config = configProvider.getConfiguration('http')
			.get<string>('proxySupport') || 'off';
	});
	const certSetting = {
		config: !!configProvider.getConfiguration('http')
			.get<boolean>('systemCertificates')
	};
	configProvider.onDidChangeConfiguration(e => {
		certSetting.config = !!configProvider.getConfiguration('http')
			.get<boolean>('systemCertificates');
	});

	return {
		http: {
			off: assign({}, http, patches(http, resolveProxy, { config: 'off' }, certSetting, true)),
			on: assign({}, http, patches(http, resolveProxy, { config: 'on' }, certSetting, true)),
			override: assign({}, http, patches(http, resolveProxy, { config: 'override' }, certSetting, true)),
			onRequest: assign({}, http, patches(http, resolveProxy, proxySetting, certSetting, true)),
			default: assign(http, patches(http, resolveProxy, proxySetting, certSetting, false)) // run last
		},
		https: {
			off: assign({}, https, patches(https, resolveProxy, { config: 'off' }, certSetting, true)),
			on: assign({}, https, patches(https, resolveProxy, { config: 'on' }, certSetting, true)),
			override: assign({}, https, patches(https, resolveProxy, { config: 'override' }, certSetting, true)),
			onRequest: assign({}, https, patches(https, resolveProxy, proxySetting, certSetting, true)),
			default: assign(https, patches(https, resolveProxy, proxySetting, certSetting, false)) // run last
		},
		tls: assign(tls, tlsPatches(tls))
	};
}

function patches(originals: typeof http | typeof https, resolveProxy: ReturnType<typeof setupProxyResolution>, proxySetting: { config: string }, certSetting: { config: boolean }, onRequest: boolean) {
	return {
		get: patch(originals.get),
		request: patch(originals.request)
	};

	function patch(original: typeof http.get) {
		function patched(url?: string | URL | null, options?: http.RequestOptions | null, callback?: (res: http.IncomingMessage) => void): http.ClientRequest {
			if (typeof url !== 'string' && !(url && (<any>url).searchParams)) {
				callback = <any>options;
				options = url;
				url = null;
			}
			if (typeof options === 'function') {
				callback = options;
				options = null;
			}
			options = options || {};

			if (options.socketPath) {
				return original.apply(null, arguments as unknown as any[]);
			}

			const optionsPatched = options.agent instanceof ProxyAgent;
			const config = onRequest && ((<any>options)._vscodeProxySupport || /* LS */ (<any>options)._vscodeSystemProxy) || proxySetting.config;
			const useProxySettings = !optionsPatched && (config === 'override' || config === 'on' && !options.agent);
			const useSystemCertificates = !optionsPatched && certSetting.config && originals === https && !(options as https.RequestOptions).ca;

			if (useProxySettings || useSystemCertificates) {
				if (url) {
					const parsed = typeof url === 'string' ? new nodeurl.URL(url) : url;
					const urlOptions = {
						protocol: parsed.protocol,
						hostname: parsed.hostname.lastIndexOf('[', 0) === 0 ? parsed.hostname.slice(1, -1) : parsed.hostname,
						port: parsed.port,
						path: `${parsed.pathname}${parsed.search}`
					};
					if (parsed.username || parsed.password) {
						options.auth = `${parsed.username}:${parsed.password}`;
					}
					options = { ...urlOptions, ...options };
				} else {
					options = { ...options };
				}
				options.agent = new ProxyAgent({
					resolveProxy: resolveProxy.bind(undefined, { useProxySettings, useSystemCertificates }),
					defaultPort: originals === https ? 443 : 80,
					originalAgent: options.agent
				});
				return original(options, callback);
			}

			return original.apply(null, arguments as unknown as any[]);
		}
		return patched;
	}
}

function tlsPatches(originals: typeof tls) {
	return {
		createSecureContext: patch(originals.createSecureContext)
	};

	function patch(original: typeof tls.createSecureContext): typeof tls.createSecureContext {
		return function (details: tls.SecureContextOptions): ReturnType<typeof tls.createSecureContext> {
			const context = original.apply(null, arguments as unknown as any[]);
			const certs = (details as any)._vscodeAdditionalCaCerts;
			if (certs) {
				for (const cert of certs) {
					context.context.addCACert(cert);
				}
			}
			return context;
		};
	}
}

function configureModuleLoading(extensionService: ExtHostExtensionService, lookup: ReturnType<typeof createPatchedModules>): Promise<void> {
	return extensionService.getExtensionPathIndex()
		.then(extensionPaths => {
			const node_module = <any>require.__$__nodeRequire('module');
			const original = node_module._load;
			node_module._load = function load(request: string, parent: any, isMain: any) {
				if (request === 'tls') {
					return lookup.tls;
				}

				if (request !== 'http' && request !== 'https') {
					return original.apply(this, arguments);
				}

				const modules = lookup[request];
				const ext = extensionPaths.findSubstr(URI.file(parent.filename).fsPath);
				if (ext && ext.enableProposedApi) {
					return modules[(<any>ext).proxySupport] || modules.onRequest;
				}
				return modules.default;
			};
		});
}

function useSystemCertificates(extHostLogService: ExtHostLogService, useSystemCertificates: boolean, opts: http.RequestOptions, callback: () => void) {
	if (useSystemCertificates) {
		getCaCertificates(extHostLogService)
			.then(caCertificates => {
				if (caCertificates) {
					if (caCertificates.append) {
						(opts as any)._vscodeAdditionalCaCerts = caCertificates.certs;
					} else {
						(opts as https.RequestOptions).ca = caCertificates.certs;
					}
				}
				callback();
			})
			.catch(err => {
				extHostLogService.error('ProxyResolver#useSystemCertificates', toErrorMessage(err));
			});
	} else {
		callback();
	}
}

let _caCertificates: ReturnType<typeof readCaCertificates> | Promise<undefined>;
async function getCaCertificates(extHostLogService: ExtHostLogService) {
	if (!_caCertificates) {
		_caCertificates = readCaCertificates()
			.then(res => res && res.certs.length ? res : undefined)
			.catch(err => {
				extHostLogService.error('ProxyResolver#getCertificates', toErrorMessage(err));
				return undefined;
			});
	}
	return _caCertificates;
}

async function readCaCertificates() {
	if (process.platform === 'win32') {
		return readWindowsCaCertificates();
	}
	if (process.platform === 'darwin') {
		return readMacCaCertificates();
	}
	if (process.platform === 'linux') {
		return readLinuxCaCertificates();
	}
	return undefined;
}

function readWindowsCaCertificates() {
	const winCA = require.__$__nodeRequire<any>('vscode-windows-ca-certs');

	let ders: any[] = [];
	const store = winCA();
	try {
		let der: any;
		while (der = store.next()) {
			ders.push(der);
		}
	} finally {
		store.done();
	}

	const seen = {};
	const certs = ders.map(derToPem)
		.filter(pem => !seen[pem] && (seen[pem] = true));
	return {
		certs,
		append: true
	};
}

async function readMacCaCertificates() {
	const stdout = (await promisify(cp.execFile)('/usr/bin/security', ['find-certificate', '-a', '-p'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout;
	const seen = {};
	const certs = stdout.split(/(?=-----BEGIN CERTIFICATE-----)/g)
		.filter(pem => !!pem.length && !seen[pem] && (seen[pem] = true));
	return {
		certs,
		append: true
	};
}

const linuxCaCertificatePaths = [
	'/etc/ssl/certs/ca-certificates.crt',
	'/etc/ssl/certs/ca-bundle.crt',
];

async function readLinuxCaCertificates() {
	for (const certPath of linuxCaCertificatePaths) {
		try {
			const content = await promisify(fs.readFile)(certPath, { encoding: 'utf8' });
			const seen = {};
			const certs = content.split(/(?=-----BEGIN CERTIFICATE-----)/g)
				.filter(pem => !!pem.length && !seen[pem] && (seen[pem] = true));
			return {
				certs,
				append: false
			};
		} catch (err) {
			if (err.code !== 'ENOENT') {
				throw err;
			}
		}
	}
	return undefined;
}

function derToPem(blob: Buffer) {
	const lines = ['-----BEGIN CERTIFICATE-----'];
	const der = blob.toString('base64');
	for (let i = 0; i < der.length; i += 64) {
		lines.push(der.substr(i, 64));
	}
	lines.push('-----END CERTIFICATE-----', '');
	return lines.join(os.EOL);
}
