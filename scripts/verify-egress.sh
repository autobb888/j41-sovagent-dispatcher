#!/usr/bin/env bash
# Verify the egress-proxy security invariants under gVisor on j41-isolated.
# Requires: firewall re-provisioned (Task 5), image rebuilt (Task 6 Step 1),
# and j41-isolated Docker network present.
set -e
GW=$(docker network inspect j41-isolated --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
PORT=9847
node -e "
  const { EgressProxyHost } = require('$PWD/src/egress-proxy.js');
  const p = new EgressProxyHost({ host: '$GW', port: $PORT });
  p.start().then(() => { p.register('T', new Set(['api.junction41.io:443'])); console.error('proxy up'); });
  setTimeout(()=>process.exit(0), 60000);
" &
NODEPID=$!; sleep 2
PROXY="http://$GW:$PORT"
echo '=== [1] gVisor + proxy → ALLOWLISTED fetch should SUCCEED ==='
docker run --rm --runtime=runsc --network j41-isolated \
  -e J41_EGRESS_PROXY="$PROXY" -e J41_EGRESS_TOKEN=T j41/job-agent:latest \
  node -e "require('/app/egress-proxy-client.js').installEgressProxy(); fetch('https://api.junction41.io/v1/tx/info').then(r=>r.text()).then(x=>console.log('  ✅ ALLOW OK:',x.slice(0,50))).catch(e=>console.log('  ❌',e.message))"
echo '=== [2] NON-allowlisted host should be DENIED ==='
docker run --rm --runtime=runsc --network j41-isolated \
  -e J41_EGRESS_PROXY="$PROXY" -e J41_EGRESS_TOKEN=T j41/job-agent:latest \
  node -e "require('/app/egress-proxy-client.js').installEgressProxy(); fetch('https://example.com').then(()=>console.log('  ❌ LEAK: example.com reachable')).catch(e=>console.log('  ✅ DENIED:',e.message))"
echo '=== [3] DIRECT egress (no proxy) should FAIL — sandbox has no direct route ==='
docker run --rm --runtime=runsc --network j41-isolated j41/job-agent:latest \
  node -e "fetch('https://api.junction41.io/v1/tx/info').then(()=>console.log('  ❌ LEAK: direct egress')).catch(e=>console.log('  ✅ no direct egress:',(e.cause&&e.cause.code)||e.message))"
echo '=== [4] DIRECT DNS should FAIL — no :53 out the bridge ==='
docker run --rm --runtime=runsc --network j41-isolated j41/job-agent:latest \
  node -e "require('dns').resolve4('example.com',(e,a)=>console.log(e?'  ✅ no DNS: '+e.code:'  ❌ DNS LEAK: '+a))"
kill $NODEPID 2>/dev/null || true
echo '=== DONE ==='
