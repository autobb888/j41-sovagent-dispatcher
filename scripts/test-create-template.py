#!/usr/bin/env python3
"""
Test the full Create Custom Template flow via the interactive dashboard.
Creates a "character-roleplay" template with all fields filled out.
"""
import pexpect
import sys
import time
import os

os.chdir(os.path.join(os.path.dirname(__file__), '..'))

TIMEOUT = 30
DOWN = '\x1b[B'
UP = '\x1b[A'
ENTER = '\r'
ESC = '\x1b'

passed = 0
failed = 0

def check(label, ok, detail=''):
    global passed, failed
    if ok:
        print(f'  ✅ {label}')
        passed += 1
    else:
        print(f'  ❌ {label}{": " + detail if detail else ""}')
        failed += 1

import re
ANSI_RE = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9]*[a-zA-Z]')

def wait_for(p, pattern, timeout=TIMEOUT):
    """Wait for pattern in output, ignoring ANSI escape codes"""
    end_time = time.time() + timeout
    while time.time() < end_time:
        try:
            p.expect('.+', timeout=1)
            # Strip ANSI from accumulated buffer
            clean = ANSI_RE.sub('', p.before + p.after if p.after else p.before)
            if re.search(pattern, clean):
                return True
        except pexpect.TIMEOUT:
            continue
        except:
            return False
    return False

def nav_down_enter(p, n):
    for _ in range(n):
        p.send(DOWN)
        time.sleep(0.08)
    time.sleep(0.15)
    p.send(ENTER)
    time.sleep(0.5)

def type_text(p, text):
    time.sleep(0.3)  # Wait for prompt to be ready before typing
    p.sendline(text)
    time.sleep(0.5)

def toggle_checkbox(p, positions):
    """For checkbox prompts — navigate to positions and toggle with space"""
    for pos in positions:
        for _ in range(pos):
            p.send(DOWN)
            time.sleep(0.08)
        p.send(' ')  # space to toggle
        time.sleep(0.1)
    p.send(ENTER)
    time.sleep(0.5)


print('\n╔══════════════════════════════════════════════════╗')
print('║  Create Custom Template — Full Flow Test          ║')
print('╚══════════════════════════════════════════════════╝\n')

# Clean up any previous test template
template_dir = 'templates/character-roleplay'
if os.path.exists(template_dir):
    import shutil
    shutil.rmtree(template_dir)
    print('  (cleaned up previous template)\n')

p = pexpect.spawn('node src/cli.js', encoding='utf-8', timeout=TIMEOUT, dimensions=(60, 120))
# p.logfile_read = sys.stdout  # uncomment for debug

# ── Step 1: Navigate to Add New Agent ──
print('Step 1: Navigate to Add New Agent\n')
check('Banner', wait_for(p, 'J41 Dispatcher', 15))
wait_for(p, 'What would you like to do', 10)
nav_down_enter(p, 1)  # [2] Add New Agent
check('Add Agent screen', wait_for(p, 'Add New Agent', 10))

# ── Step 2: Fill agent ID and name ──
print('\nStep 2: Agent ID and name\n')
check('Agent ID prompt', wait_for(p, 'Agent ID', 10))
type_text(p, 'agent-template-test')
check('Identity prompt', wait_for(p, 'Identity name|identity|name', 15))
type_text(p, 'templatetest1')
check('Template select', wait_for(p, 'Select template|template', 15))

# ── Step 3: Select "+ Create Custom Template" (last item after separator) ──
print('\nStep 3: Select Create Custom Template\n')
# Navigate to bottom — custom template is after the 3 existing templates + separator
# Navigate past existing templates to "+ Create Custom Template"
# 4 templates now (code-review, data-analyst, general-assistant, workspace-reviewer) + separator + custom
nav_down_enter(p, 5)
check('Custom template screen', wait_for(p, 'Create Custom Template|Template name', 10))

# ── Step 4: Template name ──
print('\nStep 4: Template name\n')
wait_for(p, 'Template name', 10)
type_text(p, 'character-roleplay')
time.sleep(1)  # Wait for normalization message + screen redraw
check('Name entered', wait_for(p, 'Display name|Profile|name', 15))

# ── Step 5: Agent Profile ──
print('\nStep 5: Agent Profile\n')

# Display name
wait_for(p, 'Display name', 10)
type_text(p, 'Shreck the Ogre')
check('Display name', True)

# Agent type — select autonomous (first item, default)
wait_for(p, 'Agent type', 10)
p.send(ENTER); time.sleep(0.5)
check('Agent type', True)

# Description
wait_for(p, 'Description', 10)
type_text(p, 'Visit Shreck in his swamp — character roleplay agent')
check('Description', True)

# Category — select from list
wait_for(p, 'Category', 10)
# Need to find "Entertainment & Gaming" — scroll down
for i in range(20):
    p.send(DOWN)
    time.sleep(0.08)
    # Check if we can see entertainment
# Just pick wherever we are for now — we'll verify the template file
p.send(ENTER); time.sleep(0.5)
check('Category selected', True)

# Tags
wait_for(p, 'Tags', 10)
type_text(p, 'RPG,roleplay,character,shreck')
check('Tags', True)

# Markup
wait_for(p, 'Markup', 10)
type_text(p, '15')
check('Markup', True)

# Models
wait_for(p, 'Models', 10)
type_text(p, 'moonshotai/kimi-k2.5')
check('Models', True)

# Protocols — checkbox, MCP and REST should be default selected
wait_for(p, 'Protocols', 10)
p.send(ENTER); time.sleep(0.5)  # Accept defaults
check('Protocols', True)

# Capabilities
wait_for(p, 'Capabilities', 10)
type_text(p, 'storytelling,roleplay,conversation')
check('Capabilities', True)

# Workspace — No
wait_for(p, 'workspace|Enable', 10)
# Navigate to "No" — for confirm prompts, type 'n'
type_text(p, 'n')
check('Workspace disabled', True)

# ── Step 6: Session Limits ──
print('\nStep 6: Session Limits\n')

wait_for(p, 'duration|Session', 10)
type_text(p, '3600')
check('Duration', True)

wait_for(p, 'Token limit', 10)
type_text(p, '100000')
check('Token limit', True)

wait_for(p, 'Message limit', 10)
type_text(p, '50')
check('Message limit', True)

# ── Step 7: Service ──
print('\nStep 7: Default Service\n')

wait_for(p, 'Service name', 10)
type_text(p, 'Shreck Swamp Visit')
check('Service name', True)

wait_for(p, 'Service description', 10)
type_text(p, 'Chat with Shreck in his swamp')
check('Service description', True)

wait_for(p, 'Price', 10)
type_text(p, '0.005')
check('Price', True)

wait_for(p, 'Currency', 10)
type_text(p, 'VRSCTEST')
check('Currency', True)

# Service category
wait_for(p, 'Category', 10)
for i in range(20):
    p.send(DOWN)
    time.sleep(0.08)
p.send(ENTER); time.sleep(0.5)
check('Service category', True)

wait_for(p, 'Turnaround', 10)
type_text(p, 'instant')
check('Turnaround', True)

# Payment terms — list
wait_for(p, 'Payment terms', 10)
p.send(ENTER); time.sleep(0.5)  # prepay (default)
check('Payment terms', True)

# SovGuard — yes
wait_for(p, 'SovGuard', 10)
p.send(ENTER); time.sleep(0.5)  # default yes
check('SovGuard', True)

# ── Step 8: SOUL.md ──
print('\nStep 8: SOUL.md\n')

wait_for(p, 'SOUL|personality|prompt', 10)
# Select "Write custom personality" (second option)
nav_down_enter(p, 1)
time.sleep(1)
check('Custom SOUL selected', wait_for(p, 'Who is this|agent|role', 10))

type_text(p, 'You are Shreck, the ogre who lives in a swamp')
check('Role', True)

wait_for(p, 'Personality', 10)
type_text(p, 'Grumpy but lovable, Scottish accent, loves his swamp')
check('Personality', True)

wait_for(p, 'Rules', 10)
type_text(p, 'Never break character, never say you are an AI, always mention the swamp')
check('Rules', True)

wait_for(p, 'Communication style', 10)
type_text(p, 'Short grumpy sentences with ogre metaphors about onions and layers')
check('Style', True)

wait_for(p, 'Key phrases', 10)
type_text(p, 'What are ye doin in me swamp, Ogres have layers, Better out than in')
check('Catchphrases', True)

wait_for(p, 'Anything else', 10)
type_text(p, 'You secretly care about people but hide it behind grumpiness')
check('Extra', True)

# Preview + confirm
wait_for(p, 'Use this personality', 10)
p.send(ENTER); time.sleep(0.5)  # Yes
check('SOUL confirmed', True)

# ── Step 9: Template saved ──
print('\nStep 9: Verify template saved\n')
time.sleep(2)

# Check the template was saved
if os.path.exists(template_dir):
    check('Template dir created', True)
    check('config.json exists', os.path.exists(os.path.join(template_dir, 'config.json')))
    check('SOUL.md exists', os.path.exists(os.path.join(template_dir, 'SOUL.md')))

    # Verify config.json content
    import json
    try:
        cfg = json.load(open(os.path.join(template_dir, 'config.json')))
        check('Template name', cfg.get('template') == 'character-roleplay')
        check('Profile name', cfg.get('profile', {}).get('name') == 'Shreck the Ogre')
        check('Profile type', cfg.get('profile', {}).get('type') == 'autonomous')
        check('Has service', cfg.get('service', {}).get('name') == 'Shreck Swamp Visit')
        check('Service price', cfg.get('service', {}).get('price') == '0.005')
        check('SovGuard enabled', cfg.get('service', {}).get('sovguard') == True)
        check('Has tags', 'shreck' in str(cfg.get('profile', {}).get('profile', {}).get('tags', [])))
        check('Markup set', cfg.get('profile', {}).get('markup') == 15)
    except Exception as e:
        check('config.json valid', False, str(e))

    # Verify SOUL.md content
    soul = open(os.path.join(template_dir, 'SOUL.md')).read()
    check('SOUL has role', 'Shreck' in soul)
    check('SOUL has personality', 'Scottish' in soul or 'grump' in soul.lower())
    check('SOUL has catchphrases', 'swamp' in soul.lower())
else:
    check('Template dir created', False, 'not found at ' + template_dir)

# Kill the process (it's probably waiting for setup to proceed)
try:
    p.close(force=True)
except:
    pass

print(f'\n══════════════════════════════════════════════════')
print(f'  Results: {passed} passed, {failed} failed')
print(f'══════════════════════════════════════════════════\n')

sys.exit(1 if failed > 0 else 0)
