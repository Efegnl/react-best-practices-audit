# React Best Practices Audit Tool

A lightweight, pattern-based audit tool to identify performance bottlenecks and architectural anti-patterns in React and Next.js applications.

## Key Features

- **Waterfall Detection**: Identifies sequential awaits in API routes and components that could be parallelized.
- **Bundle Optimization**: Detects barrel imports, heavy package overhead, and missing dynamic imports.
- **Server Performance**: Audits for missing React.cache() deduplication, oversized RSC boundaries, and static I/O in requests.
- **Re-render Optimization**: Finds nested component definitions, broad useEffect dependencies, and missing memoization.
- **Modern React Patterns**: Includes checks for Suspense boundaries, useDeferredValue, and React DOM resource hints.

## Getting Started

### 1. Installation
Copy `audit.mjs` to your project's `scripts/` directory or root.

### 2. Configuration
Open `audit.mjs` and adjust the `CONFIG` object if needed:
```javascript
const CONFIG = {
  scanDirs: ['src', 'app', 'components', 'lib'], // Directories to scan
  extensions: ['.ts', '.tsx', '.js', '.jsx'],    // File extensions
  exclude: ['node_modules', '.next', 'dist'],   // Directories to skip
  whitelist: [],                                // Specific files to ignore
};
```

### 3. Usage
Run the audit using Node.js:
```bash
node audit.mjs
```

The results will be printed to the console and saved to `react-audit-results.txt`.

## How it Works
The tool uses a combination of regex patterns and AST-like custom logic to scan your codebase against 60+ best practices rules curated from high-performance React engineering standards.

## Rule Categories
1. **Eliminating Waterfalls**
2. **Bundle Size Optimization**
3. **Server-Side Performance**
4. **Client-Side Data Fetching**
5. **Re-render Optimization**
6. **Rendering Performance**
7. **JavaScript Performance**

## Credits
Based on React performance guidelines maintained by Vercel Engineering and adapted for standalone use.
