import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '.');

const CONFIG = {
  scanDirs: ['app', 'components', 'lib'],
  extensions: ['.ts', '.tsx'],
  exclude: ['node_modules', '.next', 'generated', 'src/generated'],
  whitelist: [],
  productionDomains: [], // User can add their domains here (e.g., 'example.com')
};

const PRIORITY_ORDER = {
  CRITICAL: 0,
  HIGH: 1,
  'MEDIUM-HIGH': 2,
  MEDIUM: 3,
  'LOW-MEDIUM': 4,
  LOW: 5,
};

function readOptimizedPackages() {
  const configCandidates = ['next.config.mjs', 'next.config.js', 'next.config.ts']
    .map((file) => path.join(ROOT_DIR, file))
    .filter((filePath) => fs.existsSync(filePath));

  const optimized = new Set();

  for (const configPath of configCandidates) {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/optimizePackageImports\s*:\s*\[([\s\S]*?)\]/m);
    if (!match) continue;

    const listBody = match[1];
    const entries = [...listBody.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    entries.forEach((entry) => optimized.add(entry));
  }

  return optimized;
}

const OPTIMIZED_PACKAGES = readOptimizedPackages();
const CLIENT_FILE_CACHE = new Map();

function lineFromIndex(content, index) {
  return content.slice(0, index).split('\n').length;
}

function singleIssue(line, message) {
  return [{ line, message }];
}

function hasAny(content, patterns) {
  return patterns.some((pattern) => pattern.test(content));
}

function isClientComponent(content) {
  return content.includes("'use client'") || content.includes('"use client"');
}

function tryResolveFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
  ];

  return (
    candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ||
    null
  );
}

function resolveImportToFile(filePath, importPath) {
  if (
    !(importPath.startsWith('./') || importPath.startsWith('../') || importPath.startsWith('@/'))
  ) {
    return null;
  }

  if (importPath.startsWith('@/')) {
    const absoluteBase = path.join(ROOT_DIR, importPath.slice(2));
    return tryResolveFile(absoluteBase);
  }

  const absoluteBase = path.resolve(path.dirname(filePath), importPath);
  return tryResolveFile(absoluteBase);
}

function isClientFile(filePath) {
  if (!filePath) return false;
  if (CLIENT_FILE_CACHE.has(filePath)) return CLIENT_FILE_CACHE.get(filePath);

  const content = fs.readFileSync(filePath, 'utf8');
  const firstChunk = content.slice(0, 320);
  const result = /^\s*['"]use client['"]\s*;?/m.test(firstChunk);
  CLIENT_FILE_CACHE.set(filePath, result);
  return result;
}

function getImportedClientComponents(content, filePath) {
  const clientComponents = new Set();
  const importRegex = /import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const specifier = match[1];
    const importTarget = match[2];
    const resolved = resolveImportToFile(filePath, importTarget);
    if (!resolved || !isClientFile(resolved)) continue;

    const defaultMatch = specifier.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultMatch && /^[A-Z]/.test(defaultMatch[1])) {
      clientComponents.add(defaultMatch[1]);
    }

    const namedMatch = specifier.match(/\{([^}]+)\}/);
    if (namedMatch) {
      namedMatch[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach((entry) => {
          const aliasMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
          const localName = aliasMatch ? aliasMatch[2] : entry;
          if (/^[A-Z]/.test(localName)) clientComponents.add(localName);
        });
    }
  }

  return clientComponents;
}

function findMatchingBrace(content, openBraceIndex) {
  if (openBraceIndex < 0 || content[openBraceIndex] !== '{') return -1;
  let depth = 1;
  for (let i = openBraceIndex + 1; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1;
    if (content[i] === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

const RULES = [
  // 1. Eliminating Waterfalls
  {
    name: 'Prevent Waterfall Chains in API Routes',
    priority: 'CRITICAL',
    description:
      'Resolve independent async work in API routes concurrently (start early, await late).',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('app/api/')) return [];

      const issues = [];
      const specificPattern =
        /const\s+resolvedParams\s*=\s*await\s+params\s*;?\s*\n\s*const\s+session\s*=\s*await\s+auth\.api\.getSession\(\{\s*headers:\s*await\s+headers\(\)\s*\}\)\s*;?/g;
      let match;
      while ((match = specificPattern.exec(content)) !== null) {
        issues.push({
          line: lineFromIndex(content, match.index),
          message:
            'Sequential params/session awaits detected. Use Promise.all([params, getSession]).',
        });
      }

      const genericPattern =
        /const\s+(\w+)\s*=\s*await\s+([\w.]+)\(([^)]*)\)\s*;?\s*\n\s*const\s+(\w+)\s*=\s*await\s+([\w.]+)\(([^)]*)\)/g;
      while ((match = genericPattern.exec(content)) !== null) {
        const snippet = match[0];
        const firstVar = match[1];
        const secondArgs = match[6] || '';
        if (/request\.json\(\)|safeParse|parse\(|validate/.test(snippet)) continue;
        if (/\$transaction|\btx\./.test(snippet)) continue;
        if (new RegExp(`\\b${firstVar}\\b`).test(secondArgs)) continue; // dependent chain
        issues.push({
          line: lineFromIndex(content, match.index),
          message:
            'Sequential await chain in API route detected; check for parallelization opportunity.',
        });
      }

      return issues;
    },
  },
  {
    name: 'Promise.all for Independent Operations',
    priority: 'CRITICAL',
    description: 'Independent async operations should run in Promise.all.',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.tsx')) return [];
      const waterfallRegex =
        /await\s+(fetch|prisma|db|redis|auth)\s*\([^\n]*\);?[\s\S]{1,160}await\s+(fetch|prisma|db|redis|auth)\s*\([^\n]*\);?/g;
      const issues = [];
      let match;
      while ((match = waterfallRegex.exec(content)) !== null) {
        const chunk = match[0];
        if (/Promise\.all|\$transaction/.test(chunk)) continue;
        issues.push({
          line: lineFromIndex(content, match.index),
          message: 'Potential sequential data fetching detected; evaluate Promise.all.',
        });
      }
      return issues;
    },
  },
  {
    name: 'Avoid Await in Loops for Independent Work',
    priority: 'CRITICAL',
    description: 'Use Promise.all when iterating independent async operations.',
    custom: (content, _filePath, relativePath) => {
      if (!(relativePath.startsWith('app/') || relativePath.startsWith('lib/'))) return [];
      const issues = [];
      const forEachAsyncPattern = /\.forEach\s*\(\s*async\s*\([^)]*\)\s*=>/g;
      let match;
      while ((match = forEachAsyncPattern.exec(content)) !== null) {
        issues.push({
          line: lineFromIndex(content, match.index),
          message:
            'forEach(async ...) detected. Consider Promise.all(...) with map() for concurrent control.',
        });
      }

      const forOfPattern = /for\s*\(\s*(const|let)\s+([A-Za-z_$][\w$]*)\s+of\s+[^\)]*\)\s*\{/g;
      while ((match = forOfPattern.exec(content)) !== null) {
        const loopStart = match.index;
        const loopVar = match[2];
        const openBraceIndex = content.indexOf('{', loopStart);
        const endBraceIndex = findMatchingBrace(content, openBraceIndex);
        if (endBraceIndex === -1) continue;

        const body = content.slice(openBraceIndex + 1, endBraceIndex);
        if (!/\bawait\b/.test(body)) continue;
        if (/await\s+Promise\.all\(/.test(body)) continue;
        if (/for\s+await\s*\(/.test(content.slice(loopStart, endBraceIndex + 1))) continue;

        // Common intentional sequential patterns: ordering, throttling, locking, or transactional writes.
        if (
          /(rate[-_\s]?limit|throttle|sleep|delay|backoff|queue|semaphore|mutex|lock|ordered|sequential)/i.test(
            body
          )
        )
          continue;
        if (/\$transaction|tx\./.test(body)) continue;
        if (/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(body))
          continue;
        if (/\b(break|continue)\b/.test(body)) continue;

        const awaitCallMatch = body.match(/await\s+([^;\n]+)/);
        if (!awaitCallMatch) continue;
        const callExpr = awaitCallMatch[1];
        if (
          !/(fetch\(|axios\.|prisma\.|db\.|redis\.|auth\.|\.find(Unique|Many|First)\(|\.get\()/i.test(
            callExpr
          )
        )
          continue;
        if (!new RegExp(`\\b${loopVar}\\b`).test(callExpr)) continue;

        issues.push({
          line: lineFromIndex(content, loopStart),
          message:
            'Potential independent await in for..of loop detected; evaluate Promise.all parallelization.',
        });
      }

      return issues;
    },
  },
  {
    name: 'Dependency-Based Parallelization',
    priority: 'CRITICAL',
    description:
      'For partially-dependent async work, prefer better-all/start-promises-early patterns.',
    custom: (content) => {
      const pattern =
        /const\s*\[[^\]]+\]\s*=\s*await\s+Promise\.all\([\s\S]{1,260}\)\s*;?\s*\n\s*const\s+\w+\s*=\s*await\s+\w+\(/g;
      const match = pattern.exec(content);
      if (!match) return [];
      return singleIssue(
        lineFromIndex(content, match.index),
        'Promise.all followed by another await found; partial dependency may be parallelizable (better-all candidate).'
      );
    },
  },
  {
    name: 'Strategic Suspense Boundaries',
    priority: 'HIGH',
    description:
      'Async pages/layouts with awaited data can stream faster with Suspense boundaries.',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('app/')) return [];
      if (!/export\s+default\s+async\s+function/.test(content)) return [];
      if (!/\bawait\b/.test(content)) return [];
      if (
        hasAny(content, [
          /<Suspense\b/,
          /\bSuspense\b.*from ['"]react['"]/,
          /from ['"]react['"].*\bSuspense\b/,
        ])
      )
        return [];
      return singleIssue(
        1,
        'Async page/layout awaits data without Suspense. Consider splitting slow section behind Suspense.'
      );
    },
  },

  // 2. Bundle Size Optimization
  {
    name: 'Avoid Barrel File Imports',
    priority: 'CRITICAL',
    description: 'Avoid broad barrel imports; import direct modules where possible.',
    pattern: /from ['"](@\/components|@\/lib\/utils\/index|\.\.\/[^'"]*\/index)['"]/g,
    message: 'Barrel/index import detected.',
  },
  {
    name: 'Heavy Package Barrel Import',
    priority: 'HIGH',
    description: 'Large package entry imports can hurt boot/cold-start time.',
    custom: (content) => {
      const pattern =
        /from ['"](lucide-react|react-icons|@mui\/material|@mui\/icons-material|lodash|date-fns|ramda|rxjs)['"]/g;
      const issues = [];
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const pkg = match[1];
        if (OPTIMIZED_PACKAGES.has(pkg)) continue;
        issues.push({
          line: lineFromIndex(content, match.index),
          message: `Heavy package barrel import detected for "${pkg}".`,
        });
      }
      return issues;
    },
  },
  {
    name: 'Heavy Package Namespace Import',
    priority: 'HIGH',
    description: 'Namespace imports from heavy packages often increase parse and bundle costs.',
    custom: (content) => {
      const pattern =
        /import\s+\*\s+as\s+\w+\s+from\s+['"](lucide-react|react-icons|lodash|date-fns|rxjs)['"]/g;
      const issues = [];
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const pkg = match[1];
        if (OPTIMIZED_PACKAGES.has(pkg)) continue;
        issues.push({
          line: lineFromIndex(content, match.index),
          message: `Namespace import from "${pkg}" detected; prefer direct module imports.`,
        });
      }
      return issues;
    },
  },
  {
    name: 'Conditional Module Loading',
    priority: 'HIGH',
    description: 'Heavy libraries should be loaded only when needed.',
    custom: (content, _filePath, relativePath) => {
      if (relativePath.startsWith('app/api/') && /\/download\/route\.tsx$/.test(relativePath))
        return [];
      const heavyStatic =
        /from ['"](@react-pdf\/renderer|monaco-editor|recharts|chart\.js|three|pdfjs-dist)['"]/;
      if (!heavyStatic.test(content)) return [];
      if (/import\s*\(/.test(content) || /from ['"]next\/dynamic['"]/.test(content)) return [];
      return singleIssue(
        1,
        'Heavy library imported statically; consider conditional/dynamic loading.'
      );
    },
  },
  {
    name: 'Defer Non-Critical Third-Party Libraries',
    priority: 'CRITICAL',
    description: 'Analytics/telemetry libraries should usually be deferred after hydration.',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('app/')) return [];
      const thirdParty =
        /from ['"](@vercel\/analytics\/react|@sentry\/nextjs|posthog-js|mixpanel-browser)['"]/;
      if (!thirdParty.test(content)) return [];
      if (/from ['"]next\/dynamic['"]/.test(content)) return [];
      return singleIssue(
        1,
        'Non-critical third-party library imported eagerly; consider dynamic import with ssr:false.'
      );
    },
  },
  {
    name: 'Dynamic Imports for Heavy Components',
    priority: 'HIGH',
    description: 'Potentially heavy components should use next/dynamic when not needed initially.',
    custom: (content) => {
      if (!isClientComponent(content)) return [];
      const heavyComponent =
        /import\s+.*(Monaco|Editor|Chart|Pdf|Visualization).*from ['"](\.\/|\.\.\/|@\/components\/)[^'"]+['"]/;
      if (!heavyComponent.test(content)) return [];
      if (/from ['"]next\/dynamic['"]/.test(content)) return [];
      return singleIssue(
        1,
        'Potential heavy component imported statically; evaluate next/dynamic.'
      );
    },
  },
  {
    name: 'Preload Based on User Intent',
    priority: 'HIGH',
    description: 'Dynamic imports for interactive features should preload on hover/focus/intent.',
    custom: (content) => {
      if (!isClientComponent(content)) return [];
      if (!/import\s*\(\s*['"](\.\/|\.\.\/|@\/components\/)[^'"]+['"]\s*\)/.test(content))
        return [];
      // If the file exports a preload function, assume the pattern is followed correctly
      if (/export\s+const\s+preload[A-Z]\w+/.test(content)) return [];
      if (/\.preload\??\(|onMouseEnter=|onFocus=|onPointerEnter=|onPreload=/.test(content))
        return [];
      if (/useEffect[\s\S]{0,260}import\s*\(/.test(content)) return [];
      return singleIssue(1, 'Dynamic import detected without obvious preload/intent hook.');
    },
  },
  {
    name: 'Intent Preload for Click-Triggered Lazy Loads',
    priority: 'HIGH',
    description: 'When loading modules on click, preload on hover/focus where practical.',
    custom: (content) => {
      if (!isClientComponent(content)) return [];
      if (!/onClick=\{[^}]*import\s*\(/.test(content)) return [];
      if (/onMouseEnter=|onPointerEnter=|onFocus=/.test(content)) return [];
      return singleIssue(1, 'Click-triggered dynamic import found without hover/focus preload.');
    },
  },

  // 3. Server-Side Performance
  {
    name: 'Cross-Request LRU Caching',
    priority: 'HIGH',
    description:
      'Server utilities with repeated DB reads may need LRU/Redis cross-request caching.',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('lib/')) return [];
      const dbReadCount = (
        content.match(/prisma\.[a-zA-Z0-9_]+\.(findUnique|findMany|findFirst|count)\(/g) || []
      ).length;
      if (dbReadCount < 3) return [];
      const hasCache = /LRUCache|Cache\.|redis|ioredis|cache\(|cache\.get|cache\.set/.test(content);
      if (hasCache) return [];
      return singleIssue(
        1,
        'Server read path has no obvious cross-request cache; evaluate LRU/Redis caching.'
      );
    },
  },
  {
    name: 'Deduplicate Repeated Fetch Calls',
    priority: 'HIGH',
    description:
      'Repeated identical fetch() calls in one module often need deduplication or cache wrappers.',
    custom: (content, _filePath, relativePath) => {
      if (!(relativePath.startsWith('app/') || relativePath.startsWith('lib/'))) return [];
      if (isClientComponent(content)) return [];
      const fetchMatches = [...content.matchAll(/fetch\(\s*['"]([^'"]+)['"]/g)];
      if (fetchMatches.length < 2) return [];

      const counts = fetchMatches.reduce((acc, match) => {
        const url = match[1];
        acc[url] = (acc[url] || 0) + 1;
        return acc;
      }, {});

      const duplicateUrl = Object.keys(counts).find((url) => counts[url] > 1);
      if (!duplicateUrl) return [];
      if (/\bcache\(|next:\s*\{\s*revalidate|unstable_cache/.test(content)) return [];

      const first = fetchMatches.find((match) => match[1] === duplicateUrl);
      return singleIssue(
        lineFromIndex(content, first?.index ?? 0),
        `Repeated fetch("${duplicateUrl}") detected; evaluate React.cache(), unstable_cache, or shared fetch helper.`
      );
    },
  },
  {
    name: 'Per-Request Deduplication with React.cache()',
    priority: 'HIGH',
    description: 'Shared server helpers can deduplicate per request using React.cache().',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('lib/')) return [];
      if (
        !/export\s+async\s+function\s+(get|fetch)(Current|User|Session|Profile|Settings)/.test(
          content
        )
      )
        return [];
      if (/\bcache\(/.test(content)) return [];
      return singleIssue(1, 'Shared server helper detected without React.cache() deduplication.');
    },
  },
  {
    name: 'Parallel Data Fetching with Component Composition',
    priority: 'HIGH',
    description: 'Too much top-level awaiting in async pages can serialize rendering.',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('app/')) return [];
      if (!/export\s+default\s+async\s+function/.test(content)) return [];
      const awaitCount = (content.match(/\bawait\b/g) || []).length;
      if (awaitCount < 3) return [];
      if (/<Suspense\b/.test(content)) return [];
      return singleIssue(
        1,
        'Multiple awaits in top-level async page; consider splitting data fetch across composed components.'
      );
    },
  },
  {
    name: 'Minimize Serialization at RSC Boundaries',
    priority: 'HIGH',
    description: 'Avoid passing large objects from server components to client components.',
    custom: (content, filePath, relativePath) => {
      if (!relativePath.startsWith('app/')) return [];
      if (content.includes("'use client'") || content.includes('"use client"')) return [];
      const clientComponents = getImportedClientComponents(content, filePath);
      if (clientComponents.size === 0) return [];
      const pattern = /<([A-Z][A-Za-z0-9]*)\s+(user|data|submission|invoice|order)=\{\w+\}/g;
      const issues = [];
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (!clientComponents.has(match[1])) continue;
        issues.push({
          line: lineFromIndex(content, match.index),
          message: `Potential oversized prop passed to ${match[1]}. Prefer passing only required fields.`,
        });
      }
      return issues;
    },
  },
  {
    name: 'Avoid Prop Spread Across RSC Boundaries',
    priority: 'HIGH',
    description: 'Spreading server objects into client components can serialize excessive data.',
    custom: (content, filePath, relativePath) => {
      if (!relativePath.startsWith('app/')) return [];
      if (isClientComponent(content)) return [];
      const clientComponents = getImportedClientComponents(content, filePath);
      if (clientComponents.size === 0) return [];

      const pattern = /<([A-Z][A-Za-z0-9]*)\s+\{\.\.\.(\w+)\}/g;
      const issues = [];
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (!clientComponents.has(match[1])) continue;
        issues.push({
          line: lineFromIndex(content, match.index),
          message: `Prop spread into ${match[1]} detected ({...${match[2]}); pass only required fields.`,
        });
      }

      return issues;
    },
  },
  {
    name: 'Avoid Passing Large Collections at RSC Boundaries',
    priority: 'HIGH',
    description:
      'Passing full list/data collections to client components can increase serialization cost.',
    custom: (content, filePath, relativePath) => {
      if (!relativePath.startsWith('app/')) return [];
      if (isClientComponent(content)) return [];
      const clientComponents = getImportedClientComponents(content, filePath);
      if (clientComponents.size === 0) return [];
      const pattern =
        /<([A-Z][A-Za-z0-9]*)\s+[A-Za-z0-9_]*(list|items|rows|records|data)=\{\w+\}/gi;
      const issues = [];
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (!clientComponents.has(match[1])) continue;
        issues.push({
          line: lineFromIndex(content, match.index),
          message: `Collection prop passed to ${match[1]}; consider passing compact derived fields.`,
        });
      }
      return issues;
    },
  },

  // 4. Client-Side Data Fetching
  {
    name: 'Deduplicate Global Event Listeners',
    priority: 'MEDIUM-HIGH',
    description: 'Reusable listeners should avoid per-instance duplication where possible.',
    custom: (content) => {
      const listenerEffect =
        /useEffect\s*\([\s\S]{1,320}(window|document)\.addEventListener\([\s\S]{1,240}\[[^\]]*(on[A-Z]\w+|handler|callback)[^\]]*\]\s*\)/;
      if (!listenerEffect.test(content)) return [];
      if (/useSWRSubscription\(/.test(content)) return [];
      return singleIssue(
        1,
        'Global listener in effect depends on callback identity; may resubscribe often.'
      );
    },
  },
  {
    name: 'Use SWR for Automatic Deduplication',
    priority: 'MEDIUM-HIGH',
    description:
      'Client-side fetch in useEffect should usually use SWR for dedup/cache/revalidation.',
    custom: (content) => {
      const results = [];
      const matches = [...content.matchAll(/useEffect\s*\(/g)];
      matches.forEach((match) => {
        const startPos = match.index;
        const bodyStart = content.indexOf('{', startPos);
        if (bodyStart === -1 || bodyStart > startPos + 120) return;
        let braceCount = 1;
        let endPos = -1;
        for (let i = bodyStart + 1; i < content.length; i += 1) {
          if (content[i] === '{') braceCount += 1;
          if (content[i] === '}') braceCount -= 1;
          if (braceCount === 0) {
            endPos = i;
            break;
          }
        }
        if (endPos === -1) return;
        const body = content.substring(bodyStart, endPos);
        if (body.includes('fetch(') && !/useSWR|useSWRMutation/.test(content)) {
          results.push({
            line: lineFromIndex(content, startPos),
            message: 'fetch() inside useEffect detected; consider SWR hook.',
          });
        }
      });
      return results;
    },
  },
  {
    name: 'Consolidate Repeated Client Effects into SWR',
    priority: 'MEDIUM-HIGH',
    description:
      'Multiple client effects fetching data should usually be consolidated with SWR keys.',
    custom: (content) => {
      if (!isClientComponent(content)) return [];
      const effectCount = (content.match(/useEffect\s*\(/g) || []).length;
      if (effectCount < 2) return [];
      const fetchCount = (content.match(/\b(fetch|axios\.(get|post|put|patch|delete))\s*\(/g) || [])
        .length;
      if (fetchCount < 2) return [];
      if (/useSWR|useSWRMutation/.test(content)) return [];
      return singleIssue(1, 'Multiple effect-based client fetch calls detected without SWR.');
    },
  },
  {
    name: 'Use SWR for Client Axios Calls',
    priority: 'MEDIUM-HIGH',
    description:
      'Client-side axios requests in effects should usually use SWR deduplication patterns.',
    custom: (content) => {
      if (!isClientComponent(content)) return [];
      if (!/useEffect\s*\(/.test(content)) return [];
      if (!/axios\.(get|post|put|patch|delete)\(/.test(content)) return [];
      if (/useSWR|useSWRMutation/.test(content)) return [];
      return singleIssue(1, 'axios call inside client effect detected without SWR usage.');
    },
  },
  {
    name: 'Use Stable SWR Keys',
    priority: 'MEDIUM-HIGH',
    description: 'Object literal keys in SWR can be unstable and reduce dedup/cache effectiveness.',
    custom: (content) => {
      if (!/useSWR\s*\(/.test(content)) return [];
      const literalKeyPattern =
        /useSWR\s*\(\s*(\{[\s\S]{1,120}\}|\[[\s\S]{1,120}\{[\s\S]{1,120}\})\s*,/g;
      const issues = [];
      let match;
      while ((match = literalKeyPattern.exec(content)) !== null) {
        issues.push({
          line: lineFromIndex(content, match.index),
          message:
            'Potential unstable SWR key literal detected; prefer stable primitive/tuple keys.',
        });
      }
      return issues;
    },
  },

  // 5. Re-render Optimization
  {
    name: 'Defer State Reads to Usage Point',
    priority: 'MEDIUM',
    description: 'Avoid broad subscriptions if state is only read inside event callbacks.',
    custom: (content) => {
      if (!/useSearchParams\(\)/.test(content)) return [];
      if (!/onClick=|handle[A-Z]/.test(content)) return [];
      return singleIssue(
        1,
        'useSearchParams subscription detected; check if on-demand URLSearchParams read is enough.'
      );
    },
  },
  {
    name: 'Extract to Memoized Components',
    priority: 'MEDIUM',
    description: 'Expensive useMemo work before loading early returns may be wasted.',
    custom: (content) => {
      const memoIndex = content.search(/\buseMemo\s*\(/);
      const loadingReturnIndex = content.search(/if\s*\((loading|isLoading|pending)\)\s*return/);
      if (memoIndex !== -1 && loadingReturnIndex !== -1 && memoIndex < loadingReturnIndex) {
        return singleIssue(
          lineFromIndex(content, memoIndex),
          'useMemo occurs before loading return; consider extracting memoized child.'
        );
      }
      return [];
    },
  },
  {
    name: 'Narrow Effect Dependencies',
    priority: 'MEDIUM',
    description: 'Prefer primitive dependencies over broad object dependencies.',
    pattern:
      /useEffect\s*\([\s\S]{1,320}\[[^\]]*\b(user|session|data|params|config|filters|form|options)\b[^\]]*\]\s*\)/g,
    message: 'Potential broad dependency in useEffect. Consider narrowing to primitive fields.',
  },
  {
    name: 'Narrow Memo/Callback Dependencies',
    priority: 'MEDIUM',
    description:
      'Broad object dependencies in useMemo/useCallback can trigger unnecessary recalculation.',
    pattern:
      /use(Memo|Callback)\s*\([\s\S]{1,320}\[[^\]]*\b(user|session|data|params|config|filters|form|options)\b[^\]]*\]\s*\)/g,
    message: 'Potential broad dependency in useMemo/useCallback. Consider primitive dependencies.',
  },
  {
    name: 'Subscribe to Derived State',
    priority: 'MEDIUM',
    description: 'Use derived subscriptions instead of continuous values where possible.',
    custom: (content) => {
      if (!/useWindowWidth\(\)/.test(content)) return [];
      if (!/\bwidth\s*[<>]=?\s*\d+/.test(content)) return [];
      return singleIssue(
        1,
        'Width-based derived boolean detected; consider media-query subscription hook.'
      );
    },
  },
  {
    name: 'Use Transitions for Non-Urgent Updates',
    priority: 'MEDIUM',
    description: 'High-frequency event-driven state updates can use startTransition.',
    custom: (content) => {
      const frequentEvents = /addEventListener\(\s*['"](scroll|mousemove|resize|input)['"]/.test(
        content
      );
      const hasSetState = /set[A-Z][A-Za-z0-9_]*\(/.test(content);
      const hasTransition = /\bstartTransition\b|\buseTransition\b/.test(content);
      if (frequentEvents && hasSetState && !hasTransition) {
        return singleIssue(1, 'Frequent event updates without transition detected.');
      }
      return [];
    },
  },

  // 6. Rendering Performance
  {
    name: 'CSS content-visibility for Long Lists',
    priority: 'MEDIUM',
    description: 'Long lists should consider content-visibility + contain-intrinsic-size.',
    custom: (content, _filePath, relativePath) => {
      if (
        relativePath.includes('/api/') ||
        relativePath.includes('lib/') ||
        !relativePath.endsWith('.tsx')
      )
        return [];
      const mapCount = (content.match(/\.map\(/g) || []).length;
      if (mapCount < 2) return [];
      if (/content-?visibility|contain-?intrinsic-?size/i.test(content)) return [];
      return singleIssue(1, 'Multiple mapped lists without content-visibility hint.');
    },
  },
  {
    name: 'Hoist Static JSX Elements',
    priority: 'MEDIUM',
    description: 'Static JSX fragments can be hoisted outside render.',
    custom: (content) => {
      if (!/loading\s*&&\s*</.test(content)) return [];
      if (/const\s+\w+\s*=\s*\(\s*</.test(content)) return [];
      return singleIssue(
        1,
        'Inline static JSX for loading/placeholder detected; consider hoisting constant JSX.'
      );
    },
  },
  {
    name: 'Optimize SVG Precision',
    priority: 'MEDIUM',
    description: 'Excessive SVG path precision increases payload size.',
    pattern: /d=["'][^"']*\d+\.\d{3,}[^"']*["']/g,
    message: 'High-precision SVG path values detected.',
  },
  {
    name: 'Use React DOM Resource Hints',
    priority: 'HIGH',
    description: 'Use preconnect/preload and other resource hints for external/critical assets.',
    custom: (content) => {
      const externalUrls = (content.match(/https?:\/\/[^'"]+/g) || []).length;
      const hasHints = /preconnect|preload|prefetchDNS|preinit/.test(content);
      if (externalUrls > 2 && !hasHints && /export\s+default\s+function/.test(content)) {
        return singleIssue(1, 'Multiple external URLs detected without resource hints.');
      }
      return [];
    },
  },
  {
    name: 'Use defer or async on Script Tags',
    priority: 'HIGH',
    description: 'Script tags should be non-blocking using defer, async, or Next.js Script strategy.',
    pattern: /<script\b(?![^>]*\b(defer|async)\b)[^>]*>/g,
    message: 'Render-blocking <script> tag detected; add defer or async.',
  },
  {
    name: 'Use Activity Component for Show/Hide',
    priority: 'MEDIUM',
    description: 'Frequent show/hide of expensive UI can preserve state via Activity.',
    custom: (content) => {
      if (/\bActivity\b/i.test(content)) return [];
      const conditionalComponent =
        /\?\s*<[A-Z][A-Za-z0-9]*/.test(content) && /:\s*null/.test(content);
      if (!conditionalComponent) return [];
      return singleIssue(
        1,
        'Conditional show/hide pattern detected; evaluate Activity for expensive component trees.'
      );
    },
  },
  {
    name: 'Use Explicit Conditional Rendering',
    priority: 'MEDIUM',
    description: 'Avoid numeric && JSX patterns that can render 0/NaN.',
    pattern: /\{(count|length|total|index|num|value)\s*&&\s*</g,
    message: 'Numeric-like && render detected; prefer explicit ternary.',
  },

  // 7. JavaScript Performance
  {
    name: 'Build Index Maps for Repeated Lookups',
    priority: 'LOW-MEDIUM',
    description: 'find() inside map/loop indicates possible Map index optimization.',
    pattern: /\.map\([\s\S]{1,220}\.find\(/g,
    message: 'find() inside map() detected; consider precomputed Map index.',
  },
  {
    name: 'Cache Property Access in Loops',
    priority: 'LOW-MEDIUM',
    description: 'Deep property access inside loops should be cached locally when hot.',
    pattern: /for\s*\([^)]*\)\s*\{[\s\S]{1,220}\w+\.\w+\.\w+\.\w+/g,
    message: 'Deep property access in loop detected.',
  },
  {
    name: 'Cache Storage API Calls',
    priority: 'LOW-MEDIUM',
    description: 'Repeated storage reads should use local memoization cache.',
    custom: (content) => {
      const reads = (
        content.match(/localStorage\.getItem|sessionStorage\.getItem|document\.cookie/g) || []
      ).length;
      if (reads < 2) return [];
      if (/storageCache|cookieCache|new Map\(/.test(content)) return [];
      return singleIssue(1, 'Multiple storage reads without obvious cache.');
    },
  },
  {
    name: 'Combine Multiple Array Iterations',
    priority: 'LOW-MEDIUM',
    description: 'Repeated filters/maps on the same array can be combined.',
    pattern: /(\w+)\.filter\([\s\S]{1,160}\1\.filter\(/g,
    message: 'Repeated filter() on same array detected.',
  },
  {
    name: 'Early Return from Functions',
    priority: 'LOW-MEDIUM',
    description: 'Deep nested conditional chains may benefit from early returns.',
    custom: (content, _filePath, relativePath) => {
      // Skip UI-heavy TSX files to avoid JSX conditional false positives.
      if (relativePath.endsWith('.tsx') && !relativePath.startsWith('app/api/')) return [];
      // If file already uses early-exit style (guards), avoid noisy recommendations.
      if (/if\s*\([^)]+\)\s*(?:\{\s*)?(?:return|throw|break|continue)\b/.test(content)) return [];

      const deepNesting =
        /if\s*\([^)]+\)\s*\{[\s\S]{1,220}if\s*\([^)]+\)\s*\{[\s\S]{1,220}if\s*\([^)]+\)\s*\{/g;
      const issues = [];
      let match;
      while ((match = deepNesting.exec(content)) !== null) {
        issues.push({
          line: lineFromIndex(content, match.index),
          message: 'Deep nested conditional chain detected; evaluate early-return refactor.',
        });
      }
      return issues;
    },
  },
  {
    name: 'Hoist RegExp Creation',
    priority: 'LOW-MEDIUM',
    description: 'RegExp creation inside render/function body should be memoized/hoisted.',
    pattern: /function\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*\{[\s\S]{1,320}new\s+RegExp\(/g,
    message: 'new RegExp inside function body detected.',
  },
  {
    name: 'Use flatMap to Map and Filter in One Pass',
    priority: 'LOW-MEDIUM',
    description: 'Chaining .map().filter(Boolean) creates an intermediate array. Use .flatMap().',
    pattern: /\.map\s*\([\s\S]{1,120}\)\s*\.filter\s*\(\s*(?:Boolean|x\s*=>\s*!?!?\w+|!!\w+)\s*\)/g,
    message: 'Chain of .map().filter() detected; consider .flatMap() for single-pass.',
  },
  {
    name: 'Use Set/Map for O(1) Lookups',
    priority: 'LOW-MEDIUM',
    description: 'includes() in filters/maps can often be replaced by Set.has().',
    pattern: /\.filter\([\s\S]{1,220}\.includes\(/g,
    message: 'includes() inside filter/map detected; consider Set/Map lookup.',
  },

  // 8. Advanced Patterns
  {
    name: 'Store Event Handlers in Refs',
    priority: 'LOW',
    description: 'Global event listener effects should avoid handler-driven resubscription.',
    pattern:
      /useEffect\s*\([\s\S]{1,320}(window|document)\.addEventListener\([\s\S]{1,220}\[[^\]]*(handler|callback|on[A-Z]\w+)[^\]]*\]\s*\)/g,
    message:
      'Event listener effect depends on handler identity; consider ref-backed stable handler.',
  },
  {
    name: 'useLatest for Stable Callback Refs',
    priority: 'LOW',
    description: 'Timer/debounced effects with callback deps can use useLatest to avoid re-runs.',
    pattern:
      /useEffect\s*\([\s\S]{1,320}(setTimeout|setInterval)\([\s\S]{1,220}\[[^\]]*on[A-Z]\w+[^\]]*\]\s*\)/g,
    message: 'Timer effect depends on callback prop; consider useLatest pattern.',
  },

  // Legacy project checks that remain useful
  {
    name: 'Missing "use client" for Hooks',
    priority: 'CRITICAL',
    description: 'Files using React hooks in app/ must have the "use client" directive.',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('app/')) return [];
      if (isClientComponent(content)) return [];
      const cleaned = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      const hookMatch = cleaned.match(
        /use(State|Effect|Context|Ref|Memo|Callback|Reducer|Id|LayoutEffect|InsertionEffect|DeferredValue|SyncExternalStore|Transition|ActionState|Optimistic|FormStatus|SearchParams)/
      );
      if (!hookMatch) return [];
      return singleIssue(1, `Hook "${hookMatch[0]}" used without "use client" directive.`);
    },
  },
  {
    name: 'Missing Key in Map',
    priority: 'HIGH',
    description: 'React elements returned from map() should include a stable key prop.',
    pattern: /\.map\([^)]*\)\s*=>\s*([^({;]{0,120}<[a-zA-Z][^>]*>)/gm,
    filter: (match) => !match[0].includes('key='),
    message: 'Potential missing key prop in map() output.',
  },
  {
    name: 'Hardcoded Domain',
    priority: 'HIGH',
    description: 'Avoid hardcoded production domains/localhost in app code.',
    custom: (content) => {
      const domains = ['localhost', ...CONFIG.productionDomains].map(d => d.replace(/\./g, '\\.'));
      const pattern = new RegExp(`['"]https?:\\/\\/(${domains.join('|')})`, 'g');
      const matches = [...content.matchAll(pattern)];
      return matches.map(match => ({
        line: lineFromIndex(content, match.index),
        message: `Hardcoded domain/localhost detected: ${match[1]}`,
      }));
    },
  },
  {
    name: 'No <img> Tag',
    priority: 'MEDIUM',
    description: 'Use next/image where applicable for optimized image loading.',
    pattern: /<img\s/g,
    message: '<img> tag detected. Prefer next/image where practical.',
  },
  {
    name: 'Large Component File',
    priority: 'MEDIUM',
    description: 'Files over 500 lines often benefit from extraction/splitting.',
    custom: (content, _filePath, relativePath) => {
      const lines = content.split('\n').length;
      if (
        lines > 500 &&
        (relativePath.includes('/components/') || relativePath.includes('/app/'))
      ) {
        return singleIssue(1, `Large file detected (${lines} lines).`);
      }
      return [];
    },
  },
  {
    name: 'Direct DOM Manipulation',
    priority: 'MEDIUM',
    description: 'Prefer refs over direct DOM querying where possible.',
    pattern:
      /document\.(getElementById|querySelector|querySelectorAll|getElementsByClassName|getElementsByTagName)\(/g,
    message: 'Direct DOM manipulation detected.',
  },
  {
    name: 'Inline Styles',
    priority: 'LOW',
    description: 'Inline styles can reduce caching/reuse; prefer classes where possible.',
    pattern: /style=\{\{/g,
    message: 'Inline style detected.',
  },
  {
    name: 'Direct Browser Refresh',
    priority: 'LOW',
    description: 'Prefer state/router refresh patterns over full window reload.',
    pattern: /window\.location\.reload\(\)/g,
    message: 'window.location.reload() detected.',
  },
  {
    name: 'Console Usage',
    priority: 'LOW',
    description: 'Avoid console statements in production paths.',
    pattern: /console\.(log|warn|error|debug)\(/g,
    message: 'console usage detected.',
  },
  {
    name: 'Don\'t Define Components Inside Components',
    priority: 'HIGH',
    description: 'Component definitions inside other components cause full remounts on every render.',
    custom: (content) => {
      const results = [];
      const matches = [...content.matchAll(/(?:const|function)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|function)\s*=>|function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g)];
      
      matches.forEach((match) => {
        const componentName = match[1] || match[2];
        const startIndex = match.index;
        
        // Find if this is inside another function that looks like a component
        const before = content.slice(0, startIndex);
        const openBraces = (before.match(/\{/g) || []).length;
        const closeBraces = (before.match(/\}/g) || []).length;
        
        if (openBraces > closeBraces) {
          // Inside a block. Check if the parent block is a component.
          const parentComponentMatch = before.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Z][a-zA-Z0-9]*)|const\s+([A-Z][a-zA-Z0-9]*)\s*=\s*/);
          if (parentComponentMatch) {
            results.push({
              line: lineFromIndex(content, startIndex),
              message: `Nested component "${componentName}" detected. Move outside or use props.`,
            });
          }
        }
      });
      return results;
    },
  },
  {
    name: 'Split Combined Hook Computations',
    priority: 'MEDIUM',
    description: 'Avoid combining unrelated computations or effects in a single hook.',
    custom: (content) => {
      const issues = [];
      const pattern = /use(Memo|Effect)\s*\(\s*(?:async\s*)?\(\)\s*=>\s*\{([\s\S]{1,500})\}\s*,\s*\[([^\]]{1,200})\]\s*\)/g;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const body = match[2];
        const deps = match[3].split(',').map(d => d.trim()).filter(Boolean);
        if (deps.length < 3) continue;
        
        // Check for multiple distinct logic blocks
        const distinctBlocks = (body.match(/(?:\/\/\s*Step|\/\/\s*Task|const\s+\w+\s*=)/g) || []).length;
        if (distinctBlocks >= 3 && body.length > 200) {
          issues.push({
            line: lineFromIndex(content, match.index),
            message: 'Complex hook with multiple dependencies detected; evaluate splitting.',
          });
        }
      }
      return issues;
    },
  },
  {
    name: 'Use useDeferredValue for Expensive Renders',
    priority: 'MEDIUM',
    description: 'Keep input responsive by deferring heavy derived filtering/mapping.',
    custom: (content) => {
      if (!isClientComponent(content)) return [];
      
      const hasInput = /<input|onChange=|<Textarea|onValueChange=/.test(content);
      const hasFiltering = /\.filter\(|\.map\(/.test(content);
      const hasDeferredValue = /useDeferredValue/.test(content);
      const hasDebounce = /debounce|useDebounce/.test(content);
      
      if (!hasInput || !hasFiltering || hasDeferredValue || hasDebounce) return [];

      // Check for actual reactive filtering/mapping
      // 1. Identify state variable from input
      const stateMatch = content.match(/const\s*\[\s*(\w+)\s*,\s*set\s*\w+\s*\]\s*=\s*useState/i);
      if (stateMatch) {
        const stateVar = stateMatch[1];
        // 2. Check if this stateVar is used in a .filter or .map call
        // AND check that it's NOT inside a function starting with handle or on (event handlers)
        const reactiveFilterIndex = content.search(new RegExp(`\\.filter\\(\\s*\\w+\\s*=>.*${stateVar}.*\\)|\\.map\\(\\s*\\w+\\s*=>.*${stateVar}.*\\)`));
        
        if (reactiveFilterIndex !== -1) {
          // Check if the match is inside an event handler
          const beforeMatch = content.slice(0, reactiveFilterIndex);
          const isInsideEventHandler = /\b(?:handle|on)[A-Z]\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{[^}]*$/.test(beforeMatch);
          
          if (isInsideEventHandler) return [];

          // 3. Exclude common static/config mappings if file isn't massive
          const configMapping = /\.map\(\s*(?:field|option|column|layout|item\s*=>\s*item\.(?:id|label|value))/i.test(content);
          if (configMapping && content.length < 8000) return [];
          
          return singleIssue(1, 'Input-driven filtering in large component; consider useDeferredValue.');
        }
      }

      return [];
    },
  },
  {
    name: 'Hoist Static I/O to Module Level',
    priority: 'HIGH',
    description: 'Avoid repeated file/network I/O per request in server paths.',
    custom: (content, _filePath, relativePath) => {
      if (!relativePath.startsWith('app/api/') && !relativePath.startsWith('lib/')) return [];
      const issues = [];
      const pattern =
        /\b(?:export\s+)?async\s+function\b[\s\S]*?\{\s*[\s\S]*?\bawait\s+(?:fs\.readFile|fetch)\s*\(\s*(?:new\s+URL\(['"][^'"]+['"]|['"][^'"]+\.(?:ttf|png|jpg|json|html|svg)['"])/g;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        issues.push({
          line: lineFromIndex(content, match.index),
          message:
            'Static asset I/O detected inside async function; evaluate hoisting to module level.',
        });
      }
      return issues;
    },
  },
  {
    name: 'Initialize Expensive Objects Once',
    priority: 'LOW',
    description: 'Expensive objects/classes should be initialized once at module level.',
    custom: (content) => {
      const issues = [];
      const pattern =
        /\bfunction\s+[a-zA-Z0-9_]+\s*\(.*\)[\s\S]*?\{\s*[\s\S]*?\bnew\s+(?:OpenAI|Stripe|PrismaClient|LRUCache|PostHog|Redis)\(/g;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        issues.push({
          line: lineFromIndex(content, match.index),
          message:
            'Expensive class instantiation inside function; consider hoisting to module level.',
        });
      }
      return issues;
    },
  },
  {
    name: 'Batch DOM Style Changes',
    priority: 'LOW-MEDIUM',
    description: 'Multiple direct style changes should be batched to avoid reflows.',
    pattern: /\.style\.\w+\s*=\s*[^;]+;\s*\n\s*\w+\.style\.\w+\s*=\s*[^;]+;/g,
    message: 'Multiple consecutive style changes detected; consider class toggle or batching.',
  },
  {
    name: 'Check Array Length Before Loop',
    priority: 'LOW-MEDIUM',
    description: 'Fast-path length checks can avoid loop overhead for empty collections.',
    custom: (content) => {
      const issues = [];
      const pattern = /for\s*\(\s*(?:const|let)\s+\w+\s+of\s+(\w+)\s*\)\s*\{/g;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const arrayVar = match[1];
        const before = content.slice(Math.max(0, match.index - 2000), match.index);

        // Match if the array length or size was accessed at all before the loop
        const checkPattern = new RegExp(`${arrayVar}\\??\\.(?:length|size)`);

        if (!checkPattern.test(before)) {
          issues.push({
            line: lineFromIndex(content, match.index),
            message: 'Loop detected without prior length check; consider fast-path exit.',
          });
        }
      }
      return issues;
    },
  },
];

function scanFile(filePath) {
  const relativePath = path.relative(ROOT_DIR, filePath);
  if (CONFIG.whitelist.some((w) => relativePath === w || relativePath.startsWith(w))) return [];

  const content = fs.readFileSync(filePath, 'utf8');
  const results = [];

  RULES.forEach((rule) => {
    if (rule.custom) {
      const customResults = rule.custom(content, filePath, relativePath);
      customResults.forEach((res) => {
        results.push({
          rule: rule.name,
          priority: rule.priority,
          file: relativePath,
          line: res.line,
          message: res.message || rule.message,
          description: rule.description,
        });
      });
      return;
    }

    if (rule.pattern) {
      const matches = [...content.matchAll(rule.pattern)];
      matches.forEach((match) => {
        if (rule.filter && !rule.filter(match)) return;
        results.push({
          rule: rule.name,
          priority: rule.priority,
          file: relativePath,
          line: lineFromIndex(content, match.index),
          message: rule.message,
          description: rule.description,
        });
      });
    }
  });

  return results;
}

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach((entry) => {
    const entryPath = path.join(dir, entry);
    const isDirectory = fs.statSync(entryPath).isDirectory();

    if (isDirectory) {
      if (!CONFIG.exclude.some((ex) => entryPath.includes(ex))) {
        walkDir(entryPath, callback);
      }
      return;
    }

    if (CONFIG.extensions.includes(path.extname(entry))) {
      callback(entryPath);
    }
  });
}

function runAudit() {
  console.log('\nStarting React Best Practices Audit (March 2026)...');
  let output = 'React Best Practices Audit - March 2026 Refresh\n\n';
  const allResults = [];

  CONFIG.scanDirs.forEach((scanDir) => {
    const fullPath = path.resolve(ROOT_DIR, scanDir);
    if (!fs.existsSync(fullPath)) return;

    walkDir(fullPath, (filePath) => {
      const relativePath = path.relative(ROOT_DIR, filePath);
      process.stdout.write(`\rAuditing: ${relativePath}${' '.repeat(24)}`);
      allResults.push(...scanFile(filePath));
    });
  });

  console.log('\n');
  output += '\n';

  allResults.sort((a, b) => {
    const priorityA = PRIORITY_ORDER[a.priority] ?? 999;
    const priorityB = PRIORITY_ORDER[b.priority] ?? 999;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return a.file.localeCompare(b.file);
  });

  if (allResults.length === 0) {
    output += 'No issues found.\n';
  } else {
    const groupedByPriority = allResults.reduce((acc, result) => {
      if (!acc[result.priority]) acc[result.priority] = [];
      acc[result.priority].push(result);
      return acc;
    }, {});

    Object.keys(PRIORITY_ORDER).forEach((priority) => {
      const bucket = groupedByPriority[priority];
      if (!bucket || bucket.length === 0) return;

      output += `--- ${priority} (${bucket.length} issues) ---\n\n`;
      bucket.forEach((res) => {
        output += `[${res.file}:${res.line}] ${res.rule}\n`;
        output += `  - ${res.message}\n`;
        output += `  - ${res.description}\n\n`;
      });
    });

    output += `Audit Summary: ${allResults.length} issues\n`;
    output += '---\n';
    Object.keys(PRIORITY_ORDER).forEach((priority) => {
      if (groupedByPriority[priority]) {
        output += `${priority}: ${groupedByPriority[priority].length}\n`;
      }
    });
    output += '---\n\n';
  }

  // Write to file
  const resultFile = 'react-audit-results.txt';
  fs.writeFileSync(path.join(ROOT_DIR, resultFile), output);

  // Partial summary to console
  if (allResults.length < 50) {
    console.log(output);
  } else {
    console.log(`Audit Summary: ${allResults.length} issues`);
  }

  console.log(`\nFull results written to: ${resultFile}`);
}

runAudit();
