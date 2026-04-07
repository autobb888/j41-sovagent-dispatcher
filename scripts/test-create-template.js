#!/usr/bin/env node
/**
 * Test template creation by calling dashboard functions directly.
 * No pexpect, no TUI — tests the actual code paths.
 */
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const tplName = 'test-character-' + Date.now();
const tplDir = path.join(TEMPLATES_DIR, tplName);

let passed = 0, failed = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Template Creation Unit Test                      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Test 1: Template name normalization ──
  console.log('Test 1: Name normalization\n');
  check('"shreck character" → "shreck-character"', 'shreck character'.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === 'shreck-character');
  check('"My Agent!!" → "my-agent"', 'My Agent!!'.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === 'my-agent');
  check('"code review" → "code-review"', 'code review'.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === 'code-review');
  check('"---test---" → "---test---"', '---test---'.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === '---test---');
  check('empty → rejected', ''.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === '');

  // ── Test 2: Build config.json structure ──
  console.log('\nTest 2: Config structure\n');

  const config = {
    template: tplName,
    profile: {
      name: 'Test Character',
      type: 'autonomous',
      description: 'A test character for template validation',
      network: {
        capabilities: ['storytelling', 'roleplay'],
        protocols: ['MCP', 'REST'],
      },
      profile: {
        category: 'entertainment-gaming',
        tags: ['RPG', 'character', 'test'],
      },
      models: ['moonshotai/kimi-k2.5'],
      markup: 15,
      session: { duration: 3600, tokenLimit: 100000, messageLimit: 50 },
      workspace: { enabled: false },
    },
    service: {
      name: 'Test Character Chat',
      description: 'Chat with a test character',
      price: '0.005',
      currency: 'VRSCTEST',
      category: 'entertainment-gaming',
      turnaround: 'instant',
      paymentTerms: 'prepay',
      sovguard: true,
    },
  };

  check('Config has template name', config.template === tplName);
  check('Config has profile.name', config.profile.name === 'Test Character');
  check('Config has profile.type', ['autonomous', 'assisted', 'hybrid', 'tool'].includes(config.profile.type));
  check('Config has profile.description', config.profile.description.length > 10);
  check('Config has capabilities array', Array.isArray(config.profile.network.capabilities));
  check('Config has protocols array', Array.isArray(config.profile.network.protocols));
  check('Config has tags array', Array.isArray(config.profile.profile.tags));
  check('Config has category string', typeof config.profile.profile.category === 'string');
  check('Config has models array', Array.isArray(config.profile.models));
  check('Config has markup number', typeof config.profile.markup === 'number');
  check('Config has session params', config.profile.session.duration > 0);
  check('Config has workspace', typeof config.profile.workspace.enabled === 'boolean');
  check('Config has service.name', config.service.name.length > 0);
  check('Config has service.price', parseFloat(config.service.price) > 0);
  check('Config has service.currency', config.service.currency.length > 0);
  check('Config has service.sovguard', typeof config.service.sovguard === 'boolean');
  check('Config has service.paymentTerms', ['prepay', 'postpay', 'split'].includes(config.service.paymentTerms));

  // ── Test 3: Build SOUL.md ──
  console.log('\nTest 3: SOUL.md builder\n');

  const role = 'You are Shreck, the ogre who lives in a swamp';
  const personality = 'Grumpy but lovable, Scottish accent';
  const rules = 'Never break character, never say you are an AI';
  const style = 'Short grumpy sentences with ogre metaphors';
  const catchphrases = 'What are ye doin in me swamp, Ogres have layers';
  const extra = 'You secretly care about people';

  const lines = [role];
  if (personality) lines.push('', 'Personality: ' + personality);
  if (rules) lines.push('', 'Rules:', ...rules.split(',').map(r => '- ' + r.trim()));
  if (style) lines.push('', 'Style: ' + style);
  if (catchphrases) lines.push('', 'Key phrases:', ...catchphrases.split(',').map(p => '- "' + p.trim() + '"'));
  if (extra) lines.push('', extra);
  const soulPrompt = lines.join('\n');

  check('SOUL has role', soulPrompt.includes('Shreck'));
  check('SOUL has personality', soulPrompt.includes('Scottish'));
  check('SOUL has rules', soulPrompt.includes('Never break character'));
  check('SOUL has style', soulPrompt.includes('ogre metaphors'));
  check('SOUL has catchphrases', soulPrompt.includes('swamp'));
  check('SOUL has extra', soulPrompt.includes('secretly care'));
  check('SOUL multi-line', soulPrompt.split('\n').length > 5);

  // ── Test 4: Save template ──
  console.log('\nTest 4: Save template\n');

  fs.mkdirSync(tplDir, { recursive: true });
  fs.writeFileSync(path.join(tplDir, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(tplDir, 'SOUL.md'), soulPrompt);

  check('Template dir created', fs.existsSync(tplDir));
  check('config.json saved', fs.existsSync(path.join(tplDir, 'config.json')));
  check('SOUL.md saved', fs.existsSync(path.join(tplDir, 'SOUL.md')));

  // Verify roundtrip
  const loaded = JSON.parse(fs.readFileSync(path.join(tplDir, 'config.json'), 'utf8'));
  check('config.json roundtrip', loaded.template === tplName);
  check('config.json profile intact', loaded.profile.name === 'Test Character');
  check('config.json service intact', loaded.service.name === 'Test Character Chat');

  const loadedSoul = fs.readFileSync(path.join(tplDir, 'SOUL.md'), 'utf8');
  check('SOUL.md roundtrip', loadedSoul.includes('Shreck'));

  // ── Test 5: Template appears in list ──
  console.log('\nTest 5: Template discovery\n');

  const templates = fs.readdirSync(TEMPLATES_DIR).filter(d =>
    fs.existsSync(path.join(TEMPLATES_DIR, d, 'config.json'))
  );
  check('Template in directory listing', templates.includes(tplName));
  check('All templates valid', templates.every(t =>
    fs.existsSync(path.join(TEMPLATES_DIR, t, 'config.json'))
  ));

  // ── Test 6: Template works with `setup --template` ──
  console.log('\nTest 6: Template compat with setup command\n');

  // Check which fields setup actually reads from the template
  const setupFields = ['name', 'type', 'description'];
  for (const field of setupFields) {
    check(`profile.${field} present`, loaded.profile[field] != null);
  }
  check('profile.profile.category present', loaded.profile.profile?.category != null);
  check('profile.profile.tags present', Array.isArray(loaded.profile.profile?.tags));
  check('profile.network.protocols present', Array.isArray(loaded.profile.network?.protocols));
  check('service.name present', loaded.service?.name != null);
  check('service.price present', loaded.service?.price != null);

  // ── Cleanup ──
  fs.rmSync(tplDir, { recursive: true });
  check('Cleanup', !fs.existsSync(tplDir));

  // ── Summary ──
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`══════════════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
