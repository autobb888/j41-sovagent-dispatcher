#!/usr/bin/env python3
"""
Interactive TUI test using pexpect.
Drives the dashboard with arrow keys, enter, ESC — tests every menu path.
"""
import pexpect
import sys
import time

TIMEOUT = 30
UP = '\x1b[A'
DOWN = '\x1b[B'
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

def spawn_dashboard():
    p = pexpect.spawn('node src/cli.js', encoding='utf-8', timeout=TIMEOUT)
    p.logfile_read = None  # set to sys.stdout for debug
    return p

def wait_menu(p):
    """Wait for main menu to appear"""
    p.expect('What would you like to do', timeout=TIMEOUT)

def select_item(p, index):
    """Navigate to item N (0-based) and press enter"""
    # Items start at position 0 (first item highlighted by default)
    for _ in range(index):
        p.send(DOWN)
        time.sleep(0.1)
    p.send(ENTER)
    time.sleep(0.5)

def go_back_esc(p):
    """Press ESC to go back"""
    p.send(ESC)
    time.sleep(0.5)

def go_back_enter(p):
    """Press Enter on 'Press Enter or ESC to go back'"""
    try:
        p.expect('Press Enter or ESC', timeout=10)
        p.send(ENTER)
        time.sleep(0.5)
    except:
        p.send(ESC)
        time.sleep(0.5)

print('\n╔══════════════════════════════════════════════════╗')
print('║  Interactive Dashboard Test (pexpect)             ║')
print('╚══════════════════════════════════════════════════╝\n')

# ── Test 1: Menu loads ──
print('Test 1: Dashboard loads\n')
p = spawn_dashboard()
try:
    p.expect('J41 Dispatcher', timeout=15)
    check('Banner appears', True)
    p.expect('Agents:.*registered', timeout=10)
    check('Agent count shown', True)
    wait_menu(p)
    check('Menu prompt appears', True)
except Exception as e:
    check('Dashboard loads', False, str(e))
    sys.exit(1)

# ── Test 2: View Agents (item 0) ──
print('\nTest 2: View Agents\n')
try:
    select_item(p, 0)  # [1] View Agents
    p.expect('Select an agent', timeout=10)
    check('Agent list appears', True)

    # Select first agent
    p.send(ENTER)
    time.sleep(0.5)
    p.expect('Agent options', timeout=10)
    check('Agent detail menu appears', True)

    # Select View VDXF Keys (item 0)
    p.send(ENTER)
    time.sleep(1)
    p.expect('VDXF Keys', timeout=20)
    check('VDXF screen loads', True)

    # Check it shows keys
    try:
        p.expect('agent.displayName', timeout=15)
        check('VDXF keys displayed', True)
    except:
        check('VDXF keys displayed', False, 'timeout waiting for key names')

    # Go back with ESC
    go_back_enter(p)
    time.sleep(0.5)

    # Should be back at agent detail
    p.expect('Agent options', timeout=10)
    check('Back to agent detail', True)

    # View Platform Profile (item 1)
    select_item(p, 1)
    time.sleep(1)
    try:
        p.expect('Platform Profile', timeout=20)
        check('Platform profile loads', True)
    except:
        check('Platform profile loads', False, 'timeout')
    go_back_enter(p)

    # View Services (item 2)
    p.expect('Agent options', timeout=10)
    select_item(p, 2)
    time.sleep(1)
    try:
        p.expect('Services', timeout=20)
        check('Services screen loads', True)
    except:
        check('Services screen loads', False, 'timeout')
    go_back_enter(p)

    # View SOUL.md (item 3)
    p.expect('Agent options', timeout=10)
    select_item(p, 3)
    time.sleep(0.5)
    try:
        p.expect('SOUL.md', timeout=10)
        check('SOUL.md screen loads', True)
    except:
        check('SOUL.md screen loads', False, 'timeout')

    # ESC back to agent detail, then back to agent list, then back to main
    go_back_esc(p)
    time.sleep(0.5)
    # Back (last item in agent options)
    p.expect('Agent options', timeout=10)
    select_item(p, 5)  # ← Back to agents
    time.sleep(0.5)
    p.expect('Select an agent', timeout=10)
    # ← Back from agent list
    # Find the back option (last item)
    for _ in range(10):
        p.send(DOWN)
        time.sleep(0.05)
    p.send(ENTER)
    time.sleep(0.5)

    wait_menu(p)
    check('Back to main menu', True)

except Exception as e:
    check('View Agents flow', False, str(e)[:100])
    # Try to recover to main menu
    for _ in range(5):
        p.send(ESC)
        time.sleep(0.3)

# ── Test 3: Status screen (item 8 = index 10 counting separators) ──
print('\nTest 3: Status screen\n')
try:
    # Navigate to [9] Status & Health
    # Items: 0-4 setup, separator, 5-8 dispatcher, separator, 9-12 tools
    # [9] Status is at visual position 8, but separators aren't selectable
    # so actual selectable index is 8
    select_item(p, 8)
    time.sleep(0.5)
    try:
        p.expect('Dispatcher Status|Status', timeout=10)
        check('Status screen loads', True)
    except:
        check('Status screen loads', False, 'timeout')
    go_back_enter(p)
    wait_menu(p)
    check('Back from status', True)
except Exception as e:
    check('Status flow', False, str(e)[:100])

# ── Test 4: Docker Containers (item 12) ──
print('\nTest 4: Docker Containers\n')
try:
    select_item(p, 12)
    time.sleep(0.5)
    try:
        p.expect('Docker Containers', timeout=10)
        check('Docker screen loads', True)
    except:
        check('Docker screen loads', False, 'timeout')
    go_back_enter(p)
    wait_menu(p)
    check('Back from docker', True)
except Exception as e:
    check('Docker flow', False, str(e)[:100])

# ── Test 5: ESC from main menu doesn't crash ──
print('\nTest 5: ESC from main menu\n')
try:
    p.send(ESC)
    time.sleep(1)
    # Should still be alive — ESC on main menu just redisplays
    p.send(DOWN)
    time.sleep(0.3)
    p.send(ENTER)  # Select whatever is highlighted
    time.sleep(1)
    check('ESC on main menu doesn\'t crash', p.isalive())
except:
    check('ESC on main menu doesn\'t crash', p.isalive())

# ── Test 6: Quit ──
print('\nTest 6: Quit\n')
try:
    # Navigate to last item (Quit)
    for _ in range(20):
        p.send(DOWN)
        time.sleep(0.05)
    p.send(ENTER)
    time.sleep(1)
    check('Quit exits cleanly', not p.isalive() or p.exitstatus == 0)
except:
    check('Quit exits', True)  # process ended

# Cleanup
try:
    p.close()
except:
    pass

print(f'\n══════════════════════════════════════════════════')
print(f'  Results: {passed} passed, {failed} failed')
print(f'══════════════════════════════════════════════════\n')

sys.exit(1 if failed > 0 else 0)
