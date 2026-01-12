import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const pluginsDir = path.join(projectRoot, 'plugins');

console.log("🔌 Installing plugin dependencies...");
console.log("");

let installedCount = 0;
let skippedCount = 0;
let failedCount = 0;

if (fs.existsSync(pluginsDir)) {
    const plugins = fs.readdirSync(pluginsDir);

    for (const pluginName of plugins) {
        const pluginPath = path.join(pluginsDir, pluginName);
        
        if (fs.statSync(pluginPath).isDirectory()) {
            const packageJsonPath = path.join(pluginPath, 'package.json');

            if (fs.existsSync(packageJsonPath)) {
                console.log(`📦 Installing dependencies for plugin: ${pluginName}`);
                
                const result = spawnSync('bun', ['install'], {
                    cwd: pluginPath,
                    stdio: 'inherit',
                    shell: true
                });

                if (result.status === 0) {
                    // Check for sharp dependency and rebuild if needed
                    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
                    
                    if (dependencies && dependencies['sharp']) {
                        console.log(`🔨 Rebuilding sharp native bindings for ${pluginName}...`);
                        // Use bun pm rebuild (works without npm)
                        spawnSync('bun', ['pm', 'rebuild'], {
                            cwd: pluginPath,
                            stdio: 'inherit',
                            shell: true
                        });
                    }

                    console.log(`✅ ${pluginName} - installed successfully`);
                    installedCount++;
                } else {
                    console.log(`❌ ${pluginName} - installation failed`);
                    failedCount++;
                }
                console.log("");
            } else {
                console.log(`⏭️  Skipping ${pluginName} (no package.json)`);
                skippedCount++;
                console.log("");
            }
        }
    }
} else {
    console.error(`Plugins directory not found at ${pluginsDir}`);
}

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Summary:");
console.log(`  ✅ Installed: ${installedCount}`);
console.log(`  ⏭️  Skipped:   ${skippedCount}`);
console.log(`  ❌ Failed:    ${failedCount}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

if (failedCount > 0) {
    process.exit(1);
}
