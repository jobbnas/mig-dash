const express = require('express');
const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

function getDynamicNetworkInfo() {
  let networkInfo = {};

  try {
    const dnsOutput = execSync('cat /etc/resolv.conf 2>/dev/null | grep nameserver | head -3', { encoding: 'utf8', timeout: 3000 });
    networkInfo.dnsServers = dnsOutput.split('\n').filter(line => line.includes('nameserver')).map(line => line.split(' ')[1]).filter(Boolean);
  } catch (e) {
    networkInfo.dnsServers = [];
  }

  try {
    const routingTable = execSync('ip route show 2>/dev/null | head -10', { encoding: 'utf8', timeout: 3000 });
    networkInfo.routes = routingTable.split('\n').filter(Boolean).slice(0, 5);
  } catch (e) {
    networkInfo.routes = [];
  }

  try {
    const pingGoogle = execSync('ping -c 1 -W 1 8.8.8.8 2>/dev/null | grep "time="', { encoding: 'utf8', timeout: 3000 });
    const latencyMatch = pingGoogle.match(/time=(\d+\.?\d*)/);
    networkInfo.internetLatency = latencyMatch ? parseFloat(latencyMatch[1]) : null;
  } catch (e) {
    networkInfo.internetLatency = null;
  }

  try {
    const arpTable = execSync('arp -a 2>/dev/null | head -5', { encoding: 'utf8', timeout: 3000 });
    networkInfo.arpEntries = arpTable.split('\n').filter(Boolean).slice(0, 3);
  } catch (e) {
    networkInfo.arpEntries = [];
  }

  try {
    const publicIP = execSync('curl -s --max-time 3 ifconfig.me 2>/dev/null || curl -s --max-time 3 ipinfo.io/ip 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    networkInfo.publicIP = publicIP.trim();
  } catch (e) {
    networkInfo.publicIP = null;
  }

  try {
    const locationData = execSync('curl -s --max-time 3 "https://ipapi.co/json/" 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const location = JSON.parse(locationData);
    networkInfo.location = {
      city: location.city,
      region: location.region,
      country: location.country_name,
      isp: location.org,
      timezone: location.timezone,
      coordinates: `${location.latitude},${location.longitude}`
    };
  } catch (e) {
    networkInfo.location = null;
  }

  return networkInfo;
}

function getSystemInfo() {
  const networkInterfaces = os.networkInterfaces();
  const uptime = process.uptime();
  const dynamicNetwork = getDynamicNetworkInfo();

  let clusterInfo = {};
  let nodeInfo = {};

  try {
    if (fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace')) {
      const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
      clusterInfo.namespace = namespace;
      clusterInfo.isOpenShift = true;
    }
  } catch (e) {
    clusterInfo.isOpenShift = false;
  }

  try {
    const hostname = os.hostname();
    nodeInfo.hostname = hostname;
    nodeInfo.nodeName = process.env.NODE_NAME || hostname;
  } catch (e) {}

  try {
    if (process.env.KUBERNETES_SERVICE_HOST) {
      clusterInfo.kubernetesHost = process.env.KUBERNETES_SERVICE_HOST;
    }
  } catch (e) {}

  let ipInfo = {};
  try {
    const ipOutput = execSync('ip route get 1.1.1.1 2>/dev/null | head -1', { encoding: 'utf8', timeout: 5000 });
    const match = ipOutput.match(/src (\S+)/);
    if (match) {
      ipInfo.primaryIP = match[1];
    }
  } catch (e) {}

  try {
    const routeOutput = execSync('ip route show default 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const match = routeOutput.match(/via (\S+)/);
    if (match) {
      ipInfo.gateway = match[1];
    }
  } catch (e) {}

  return {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: Math.floor(uptime),
    uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
    memory: {
      total: Math.round(os.totalmem() / 1024 / 1024),
      free: Math.round(os.freemem() / 1024 / 1024),
      used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024)
    },
    loadAverage: os.loadavg(),
    networkInterfaces: Object.keys(networkInterfaces).reduce((acc, name) => {
      acc[name] = networkInterfaces[name].filter(interface => interface.family === 'IPv4');
      return acc;
    }, {}),
    ipInfo,
    clusterInfo,
    nodeInfo,
    dynamicNetwork,
    environment: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      CLUSTER_NAME: process.env.CLUSTER_NAME || dynamicNetwork.location?.city || 'unknown',
      DATACENTER: process.env.DATACENTER || dynamicNetwork.location?.region || 'unknown',
      ZONE: process.env.ZONE || process.env.AVAILABILITY_ZONE || dynamicNetwork.location?.timezone || 'unknown'
    }
  };
}

app.get('/', (req, res) => {
  const systemInfo = getSystemInfo();

  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>VM Migration Demo - System Info</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
            color: #e5e5e5;
            min-height: 100vh;
            overflow-x: hidden;
        }

        .bg-animation {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: radial-gradient(circle at 20% 80%, rgba(120, 119, 198, 0.1) 0%, transparent 50%),
                        radial-gradient(circle at 80% 20%, rgba(255, 119, 198, 0.1) 0%, transparent 50%),
                        radial-gradient(circle at 40% 40%, rgba(120, 219, 255, 0.1) 0%, transparent 50%);
            animation: float 20s ease-in-out infinite;
            z-index: -1;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            33% { transform: translateY(-30px) rotate(2deg); }
            66% { transform: translateY(-15px) rotate(-1deg); }
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            position: relative;
            z-index: 1;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
            padding: 30px;
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }

        h1 {
            font-size: 3rem;
            font-weight: 700;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 20px;
            text-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        }

        .migration-banner {
            background: linear-gradient(135deg, #ff6b6b 0%, #ffa726 50%, #42a5f5 100%);
            color: white;
            padding: 20px 30px;
            border-radius: 15px;
            font-weight: 600;
            font-size: 1.2rem;
            box-shadow: 0 10px 30px rgba(255, 107, 107, 0.3);
            animation: glow 3s ease-in-out infinite;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }

        @keyframes glow {
            0%, 100% { transform: scale(1); box-shadow: 0 10px 30px rgba(255, 107, 107, 0.3); }
            50% { transform: scale(1.02); box-shadow: 0 15px 40px rgba(255, 107, 107, 0.5); }
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 25px;
            margin-bottom: 30px;
        }

        .section {
            background: rgba(255, 255, 255, 0.03);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 30px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }

        .section::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #667eea, #764ba2, #667eea);
            background-size: 200% 100%;
            animation: shimmer 3s linear infinite;
        }

        @keyframes shimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
        }

        .section:hover {
            transform: translateY(-5px);
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.2);
            border-color: rgba(255, 255, 255, 0.2);
        }

        .section h2 {
            font-size: 1.4rem;
            font-weight: 600;
            margin-bottom: 20px;
            color: #a0d2eb;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .metric-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            transition: all 0.2s ease;
        }

        .metric-item:hover {
            background: rgba(255, 255, 255, 0.05);
            margin: 0 -15px;
            padding: 12px 15px;
            border-radius: 8px;
        }

        .metric-item:last-child {
            border-bottom: none;
        }

        .label {
            font-weight: 500;
            color: #b8c6db;
            font-size: 0.95rem;
        }

        .value {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 500;
            color: #a8e6cf;
            font-size: 0.95rem;
            text-align: right;
        }

        .status {
            display: inline-flex;
            align-items: center;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .status.connected {
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
            box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
        }

        .status.openshift {
            background: linear-gradient(135deg, #ff4757, #ff3742);
            color: white;
            box-shadow: 0 4px 15px rgba(255, 71, 87, 0.3);
        }

        .timestamp {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(10px);
            padding: 12px 20px;
            border-radius: 25px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            color: #a0d2eb;
            z-index: 1000;
        }

        .location-banner {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px;
            border-radius: 15px;
            margin-bottom: 30px;
            text-align: center;
            box-shadow: 0 15px 35px rgba(102, 126, 234, 0.3);
        }

        .location-info {
            display: flex;
            justify-content: space-around;
            flex-wrap: wrap;
            gap: 20px;
            margin-top: 15px;
        }

        .location-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            min-width: 120px;
        }

        .location-item .icon {
            font-size: 1.5rem;
            margin-bottom: 5px;
        }

        .network-viz {
            background: rgba(255, 255, 255, 0.02);
            border-radius: 15px;
            padding: 20px;
            margin: 15px 0;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .latency-indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .latency-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            animation: pulse-dot 2s infinite;
        }

        .latency-good { background: #4CAF50; }
        .latency-medium { background: #FF9800; }
        .latency-bad { background: #F44336; }

        @keyframes pulse-dot {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.2); opacity: 0.7; }
            100% { transform: scale(1); opacity: 1; }
        }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 8px;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #8BC34A);
            border-radius: 4px;
            transition: width 0.3s ease;
        }

        @media (max-width: 768px) {
            h1 { font-size: 2rem; }
            .stats-grid { grid-template-columns: 1fr; gap: 20px; }
            .location-info { flex-direction: column; align-items: center; }
        }

        .auto-refresh {
            text-align: center;
            margin-top: 40px;
            padding: 20px;
            color: #6c7b7f;
            font-style: italic;
        }
    </style>
    <script>
        function refreshPage() {
            location.reload();
        }
        setInterval(refreshPage, 5000);

        // Add smooth loading animation
        window.addEventListener('load', function() {
            document.body.style.opacity = '0';
            document.body.style.transition = 'opacity 0.5s ease';
            setTimeout(() => {
                document.body.style.opacity = '1';
            }, 100);
        });
    </script>
</head>
<body>
    <div class="bg-animation"></div>
    <div class="timestamp">🕒 ${new Date(systemInfo.timestamp).toLocaleTimeString()}</div>

    <div class="container">
        <div class="header">
            <h1>🚀 VM Live Migration Dashboard</h1>
            <div class="migration-banner">
                🖥️ ${systemInfo.hostname} | 🏢 ${systemInfo.environment.CLUSTER_NAME} | 🌍 ${systemInfo.environment.DATACENTER}
            </div>
        </div>

        ${systemInfo.dynamicNetwork.location ? `
        <div class="location-banner">
            <h3>📍 Current Location & Network Status</h3>
            <div class="location-info">
                <div class="location-item">
                    <div class="icon">🌆</div>
                    <div><strong>${systemInfo.dynamicNetwork.location.city}</strong></div>
                    <div>${systemInfo.dynamicNetwork.location.region}</div>
                </div>
                <div class="location-item">
                    <div class="icon">🏳️</div>
                    <div><strong>${systemInfo.dynamicNetwork.location.country}</strong></div>
                    <div>${systemInfo.dynamicNetwork.location.timezone}</div>
                </div>
                <div class="location-item">
                    <div class="icon">🌐</div>
                    <div><strong>ISP</strong></div>
                    <div>${systemInfo.dynamicNetwork.location.isp}</div>
                </div>
                ${systemInfo.dynamicNetwork.publicIP ? `
                <div class="location-item">
                    <div class="icon">📡</div>
                    <div><strong>Public IP</strong></div>
                    <div>${systemInfo.dynamicNetwork.publicIP}</div>
                </div>` : ''}
            </div>
        </div>` : ''}

        <div class="stats-grid">
            <div class="section">
                <h2>🖥️ System Metrics</h2>
                <div class="metric-item">
                    <span class="label">Hostname</span>
                    <span class="value">${systemInfo.hostname}</span>
                </div>
                <div class="metric-item">
                    <span class="label">Platform</span>
                    <span class="value">${systemInfo.platform} (${systemInfo.arch})</span>
                </div>
                <div class="metric-item">
                    <span class="label">Uptime</span>
                    <span class="value">${systemInfo.uptimeFormatted}</span>
                </div>
                <div class="metric-item">
                    <span class="label">Load Average</span>
                    <span class="value">${systemInfo.loadAverage.map(l => l.toFixed(2)).join(' • ')}</span>
                </div>
            </div>

            <div class="section">
                <h2>💾 Memory Status</h2>
                <div class="metric-item">
                    <span class="label">Total Memory</span>
                    <span class="value">${systemInfo.memory.total} MB</span>
                </div>
                <div class="metric-item">
                    <span class="label">Used Memory</span>
                    <span class="value">${systemInfo.memory.used} MB</span>
                </div>
                <div class="metric-item">
                    <span class="label">Free Memory</span>
                    <span class="value">${systemInfo.memory.free} MB</span>
                </div>
                <div class="metric-item">
                    <span class="label">Usage</span>
                    <span class="value">${((systemInfo.memory.used / systemInfo.memory.total) * 100).toFixed(1)}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${((systemInfo.memory.used / systemInfo.memory.total) * 100).toFixed(1)}%"></div>
                </div>
            </div>

            <div class="section">
                <h2>🌐 Network Connectivity</h2>
                <div class="metric-item">
                    <span class="label">Primary IP</span>
                    <span class="value">${systemInfo.ipInfo.primaryIP || 'N/A'}</span>
                </div>
                <div class="metric-item">
                    <span class="label">Gateway</span>
                    <span class="value">${systemInfo.ipInfo.gateway || 'N/A'}</span>
                </div>
                ${systemInfo.dynamicNetwork.internetLatency ? `
                <div class="metric-item">
                    <span class="label">Internet Latency</span>
                    <span class="value latency-indicator">
                        <span class="latency-dot ${systemInfo.dynamicNetwork.internetLatency < 50 ? 'latency-good' : systemInfo.dynamicNetwork.internetLatency < 100 ? 'latency-medium' : 'latency-bad'}"></span>
                        ${systemInfo.dynamicNetwork.internetLatency}ms
                    </span>
                </div>` : ''}
                <div class="metric-item">
                    <span class="label">DNS Servers</span>
                    <span class="value">${systemInfo.dynamicNetwork.dnsServers.length}</span>
                </div>
            </div>

            <div class="section">
                <h2>☸️ Kubernetes/OpenShift</h2>
                <div class="metric-item">
                    <span class="label">OpenShift Status</span>
                    <span class="value">
                        <span class="status ${systemInfo.clusterInfo.isOpenShift ? 'openshift' : 'connected'}">
                            ${systemInfo.clusterInfo.isOpenShift ? '✅ Active' : '❌ Not Detected'}
                        </span>
                    </span>
                </div>
                ${systemInfo.clusterInfo.namespace ? `
                <div class="metric-item">
                    <span class="label">Namespace</span>
                    <span class="value">${systemInfo.clusterInfo.namespace}</span>
                </div>` : ''}
                ${systemInfo.clusterInfo.kubernetesHost ? `
                <div class="metric-item">
                    <span class="label">K8s API Host</span>
                    <span class="value">${systemInfo.clusterInfo.kubernetesHost}</span>
                </div>` : ''}
                ${systemInfo.nodeInfo.nodeName ? `
                <div class="metric-item">
                    <span class="label">Node Name</span>
                    <span class="value">${systemInfo.nodeInfo.nodeName}</span>
                </div>` : ''}
            </div>
        </div>

        ${systemInfo.dynamicNetwork.dnsServers.length > 0 ? `
        <div class="section">
            <h2>🔍 Network Discovery</h2>
            <div class="network-viz">
                <h3>DNS Servers</h3>
                ${systemInfo.dynamicNetwork.dnsServers.map(dns => `
                    <div class="metric-item">
                        <span class="label">Nameserver</span>
                        <span class="value">${dns}</span>
                    </div>
                `).join('')}
            </div>

            ${systemInfo.dynamicNetwork.routes.length > 0 ? `
            <div class="network-viz">
                <h3>Active Routes</h3>
                ${systemInfo.dynamicNetwork.routes.slice(0, 3).map(route => `
                    <div class="metric-item">
                        <span class="label">Route</span>
                        <span class="value" style="font-size: 0.8rem;">${route}</span>
                    </div>
                `).join('')}
            </div>` : ''}

            ${systemInfo.dynamicNetwork.arpEntries.length > 0 ? `
            <div class="network-viz">
                <h3>Network Neighbors (ARP)</h3>
                ${systemInfo.dynamicNetwork.arpEntries.map(arp => `
                    <div class="metric-item">
                        <span class="label">Device</span>
                        <span class="value" style="font-size: 0.8rem;">${arp}</span>
                    </div>
                `).join('')}
            </div>` : ''}
        </div>` : ''}

        <div class="section">
            <h2>🔧 Network Interfaces</h2>
            ${Object.entries(systemInfo.networkInterfaces).map(([name, interfaces]) => `
                <div class="network-viz">
                    <h3>${name}</h3>
                    ${interfaces.map(iface => `
                        <div class="metric-item">
                            <span class="label">IP Address</span>
                            <span class="value">${iface.address}</span>
                        </div>
                        <div class="metric-item">
                            <span class="label">Netmask</span>
                            <span class="value">${iface.netmask}</span>
                        </div>
                        <div class="metric-item">
                            <span class="label">MAC Address</span>
                            <span class="value">${iface.mac}</span>
                        </div>
                    `).join('')}
                </div>
            `).join('')}
        </div>

        <div class="auto-refresh">
            <p>🔄 Auto-refreshing every 5 seconds | Perfect for live migration demonstrations!</p>
            <p>🚀 This dashboard shows real-time changes as the VM migrates between clusters and datacenters</p>
        </div>
    </div>
</body>
</html>`;

  res.send(html);
});

app.get('/api/info', (req, res) => {
  res.json(getSystemInfo());
});

app.listen(PORT, () => {
  console.log(`🚀 VM Migration Demo App running on port ${PORT}`);
  console.log(`📊 View system info: http://localhost:${PORT}`);
  console.log(`🔌 API endpoint: http://localhost:${PORT}/api/info`);
});