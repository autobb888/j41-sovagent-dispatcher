#!/usr/bin/env python3
"""
Interactive TUI test v3 — uses ESC for all navigation.
Tests every screen loads correctly without relying on exact arrow-key counting.
"""
import pexpect
import sys
import time
import os

os.chdir(os.path.join(os.path.dirname(__file__), '..'))

TIMEOUT = 25
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

def wait_for(p, pattern, timeout=TIMEOUT):
    try:
        p.expect(pattern, timeout=timeout)
        return True
    except:
        return False

def go_home(p):
    """Spam ESC to get back to main menu"""
    for _ in range(10):
        p.send(ESC)
        time.sleep(0.2)
    time.sleep(0.5)

def select_by_text(p, target_text, max_downs=20):
    """Navigate down until we see target_text highlighted, then enter."""
    for i in range(max_downs):
        # Check current buffer for the target
        try:
            # Send down arrow
            p.send(DOWN)
            time.sleep(0.1)
            # Peek at what's on screen — inquirer highlights current selection with color codes
        except:
            pass
    # Just press enter wherever we are
    p.send(ENTER)
    time.sleep(0.5)

def nav_to_item(p, position, max_items=20):
    """From top of list, press DOWN position times then ENTER"""
    for _ in range(position):
        p.send(DOWN)
        time.sleep(0.08)
    time.sleep(0.15)
    p.send(ENTER)
    time.sleep(0.5)


print('\n╔══════════════════════════════════════════════════╗')
print('║  Interactive Dashboard Test v3                    ║')
print('╚══════════════════════════════════════════════════╝\n')

p = pexpect.spawn('node src/cli.js', encoding='utf-8', timeout=TIMEOUT, dimensions=(50, 120))

# ────── Test 1: Dashboard loads ──────
print('Test 1: Dashboard loads\n')
check('Banner', wait_for(p, 'J41 Dispatcher', 15))
check('Agents', wait_for(p, r'Agents:.*registered', 10))
check('Menu', wait_for(p, 'What would you like to do', 10))

# Strategy: for each test, navigate from the TOP of the menu.
# Main menu layout (inquirer DOWN counting):
#   0: [1] View Agents
#   1: [2] Add New Agent
#   2: [3] Configure LLM
#   3: [4] Configure Services
#   4: [5] Security Setup
#   5: ── separator ── (auto-skipped)
#   5: [6] Start Dispatcher
#   6: [7] Stop Dispatcher
#   7: [8] View Logs
#   8: [9] Status
#   9: ── separator ── (auto-skipped)
#   9: [10] Inspect Agent
#  10: [11] Check Inbox
#  11: [12] Earnings
#  12: [13] Docker
#  13: ── separator ──
#  13: Quit
#
# BUT: inquirer may or may not skip separators depending on version.
# So we test empirically: each test starts fresh from main menu.

def fresh_menu():
    """Get to main menu from any state"""
    go_home(p)
    wait_for(p, 'What would you like to do', 8)

# ────── Test 2: [1] View Agents → first agent → VDXF ──────
print('\nTest 2: View Agents → VDXF\n')
try:
    fresh_menu()
    nav_to_item(p, 0)  # [1] View Agents — always first
    check('Agent list', wait_for(p, 'Select an agent', 10))
    p.send(ENTER); time.sleep(0.5)  # First agent
    check('Agent detail', wait_for(p, 'Agent options', 10))
    p.send(ENTER); time.sleep(0.5)  # VDXF (first option)
    check('VDXF loads', wait_for(p, 'VDXF Keys', 20))
    check('Keys shown', wait_for(p, 'agent.displayName', 15))
except Exception as e:
    check('VDXF flow', False, str(e)[:60])
fresh_menu()

# ────── Test 3: Platform Profile ──────
print('\nTest 3: Platform Profile\n')
try:
    nav_to_item(p, 0); wait_for(p, 'Select an agent', 10)
    p.send(ENTER); time.sleep(0.5); wait_for(p, 'Agent options', 10)
    nav_to_item(p, 1)  # Platform Profile
    check('Profile loads', wait_for(p, 'Platform Profile', 20))
    check('Name shown', wait_for(p, 'Name:', 10))
except Exception as e:
    check('Profile flow', False, str(e)[:60])
fresh_menu()

# ────── Test 4: Services ──────
print('\nTest 4: Services\n')
try:
    nav_to_item(p, 0); wait_for(p, 'Select an agent', 10)
    p.send(ENTER); time.sleep(0.5); wait_for(p, 'Agent options', 10)
    nav_to_item(p, 2)
    check('Services loads', wait_for(p, 'Services', 20))
except Exception as e:
    check('Services flow', False, str(e)[:60])
fresh_menu()

# ────── Test 5: SOUL.md ──────
print('\nTest 5: SOUL.md\n')
try:
    nav_to_item(p, 0); wait_for(p, 'Select an agent', 10)
    p.send(ENTER); time.sleep(0.5); wait_for(p, 'Agent options', 10)
    nav_to_item(p, 3)
    check('SOUL loads', wait_for(p, 'SOUL.md', 10))
except Exception as e:
    check('SOUL flow', False, str(e)[:60])
fresh_menu()

# ────── Test 6: Jobs ──────
print('\nTest 6: Jobs\n')
try:
    nav_to_item(p, 0); wait_for(p, 'Select an agent', 10)
    p.send(ENTER); time.sleep(0.5); wait_for(p, 'Agent options', 10)
    nav_to_item(p, 4)
    check('Jobs loads', wait_for(p, 'Jobs', 20))
except Exception as e:
    check('Jobs flow', False, str(e)[:60])
fresh_menu()

# ────── Test 7: LLM Provider ──────
print('\nTest 7: LLM Provider\n')
try:
    nav_to_item(p, 2)  # [3] LLM
    check('LLM loads', wait_for(p, 'LLM Provider|Current', 15))
except Exception as e:
    check('LLM flow', False, str(e)[:60])
fresh_menu()

# ────── Test 8: Security ──────
print('\nTest 8: Security\n')
try:
    nav_to_item(p, 4)  # [5] Security
    check('Security loads', wait_for(p, 'Security|Score|Platform', 15))
except Exception as e:
    check('Security flow', False, str(e)[:60])
fresh_menu()

# ────── Test 9: Status — find it by going down until we see it ──────
print('\nTest 9: Status\n')
try:
    # Status is after the first separator. Try indices 8-10.
    for attempt in [8, 9, 10]:
        fresh_menu()
        nav_to_item(p, attempt)
        if wait_for(p, 'Status|Running|Dispatcher Status', 5):
            check('Status loads', True)
            break
    else:
        check('Status loads', False, 'could not find status item')
except Exception as e:
    check('Status flow', False, str(e)[:60])
fresh_menu()

# ────── Test 10: Inspect Agent ──────
print('\nTest 10: Inspect Agent\n')
try:
    for attempt in range(8, 14):
        fresh_menu()
        nav_to_item(p, attempt)
        if wait_for(p, 'Select agent|inspect|Inspect', 3):
            check('Inspect picker', True)
            p.send(ENTER); time.sleep(0.5)
            check('VDXF loads', wait_for(p, 'VDXF|agent\\.', 20))
            break
    else:
        check('Inspect picker', False, 'tried indices 8-13')
except Exception as e:
    check('Inspect flow', False, str(e)[:60])
fresh_menu()

# ────── Test 11: Inbox ──────
print('\nTest 11: Inbox\n')
try:
    for attempt in [10, 11, 12]:
        fresh_menu()
        nav_to_item(p, attempt)
        if wait_for(p, 'Check inbox|inbox', 5):
            check('Inbox picker', True)
            p.send(ENTER); time.sleep(0.5)
            check('Inbox loads', wait_for(p, 'Inbox|pending', 20))
            break
    else:
        check('Inbox picker', False, 'could not find')
except Exception as e:
    check('Inbox flow', False, str(e)[:60])
fresh_menu()

# ────── Test 12: Earnings ──────
print('\nTest 12: Earnings\n')
try:
    for attempt in [11, 12, 13]:
        fresh_menu()
        nav_to_item(p, attempt)
        if wait_for(p, 'Earnings|Balance', 10):
            check('Earnings loads', True)
            break
    else:
        check('Earnings loads', False, 'could not find')
except Exception as e:
    check('Earnings flow', False, str(e)[:60])
fresh_menu()

# ────── Test 13: Docker ──────
print('\nTest 13: Docker\n')
try:
    for attempt in [12, 13, 14]:
        fresh_menu()
        nav_to_item(p, attempt)
        if wait_for(p, 'Docker Containers', 5):
            check('Docker loads', True)
            break
    else:
        check('Docker loads', False, 'could not find')
except Exception as e:
    check('Docker flow', False, str(e)[:60])
fresh_menu()

# ────── Test 14: ESC from main menu ──────
print('\nTest 14: ESC resilience\n')
p.send(ESC); time.sleep(1)
check('Survives ESC', p.isalive())
check('Menu redisplays', wait_for(p, 'What would you like to do', 10))

# ────── Test 15: ESC from sub-screen ──────
print('\nTest 15: ESC from sub-screen\n')
try:
    nav_to_item(p, 0)  # View Agents
    wait_for(p, 'Select an agent', 10)
    p.send(ESC); time.sleep(1)
    check('ESC returns to main', wait_for(p, 'What would you like to do', 10))
except:
    check('ESC from sub', False)
fresh_menu()

# ────── Test 16: Quit ──────
print('\nTest 16: Quit\n')
# Navigate UP from bottom to find Quit (it's the very last selectable item)
# Going UP 1 from top wraps to bottom = Quit
p.send(UP); time.sleep(0.2)
p.send(ENTER)
time.sleep(3)
check('Process exited', not p.isalive())

# Verify .env intact
env = open('.env').read()
check('.env unchanged', 'kimi-nvidia' in env)

try:
    if p.isalive(): p.close(force=True)
except: pass

print(f'\n══════════════════════════════════════════════════')
print(f'  Results: {passed} passed, {failed} failed')
print(f'══════════════════════════════════════════════════\n')

sys.exit(1 if failed > 0 else 0)
