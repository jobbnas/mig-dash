const express = require('express');
const { execSync } = require('child_process');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple safe execution
function safeExec(command) {
  try {
    return execSync(command, { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (error) {
    return null;
  }
}

// Get basic network info
function getNetworkInfo() {
  const data = {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: Math.floor(process.uptime()),
    platform: os.platform(),
    arch: os.arch()
  };

  // Primary IP and Gateway
  data.primaryIP = safeExec('ip route get 1.1.1.1 2>/dev/null | grep -oP "src \\K\\S+"') || 'N/A';
  data.gateway = safeExec('ip route show default 2>/dev/null | grep -oP "via \\K\\S+"') || 'N/A';

  // DNS Servers
  const dnsOutput = safeExec('grep nameserver /etc/resolv.conf 2>/dev/null | awk \'{print $2}\'');
  data.dnsServers = dnsOutput ? dnsOutput.split('\n').filter(Boolean) : [];

  // Public IP and Location
  data.publicIP = safeExec('curl -s --max-time 3 ifconfig.me 2>/dev/null') || 'N/A';

  // Get location data
  if (data.publicIP !== 'N/A') {
    try {
      const locationJson = safeExec(`curl -s --max-time 3 "https://ipapi.co/${data.publicIP}/json/" 2>/dev/null`);
      const location = JSON.parse(locationJson || '{}');
      data.location = {
        city: location.city || 'Unknown',
        region: location.region || 'Unknown',
        country: location.country_name || 'Unknown',
        isp: location.org || 'Unknown',
        timezone: location.timezone || 'Unknown'
      };
    } catch (e) {
      data.location = null;
    }
  }

  // Network interfaces
  const interfaces = os.networkInterfaces();
  data.interfaces = {};
  Object.keys(interfaces).forEach(name => {
    const ipv4 = interfaces[name].find(iface => iface.family === 'IPv4' && !iface.internal);
    if (ipv4) {
      data.interfaces[name] = {
        ip: ipv4.address,
        netmask: ipv4.netmask,
        mac: ipv4.mac
      };
    }
  });

  // Simple latency test
  const pingResult = safeExec('ping -c 1 -W 1 8.8.8.8 2>/dev/null | grep "time="');
  data.internetLatency = null;
  if (pingResult) {
    const match = pingResult.match(/time=([0-9.]+)/);
    data.internetLatency = match ? parseFloat(match[1]) : null;
  }

  return data;
}

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API endpoint
app.get('/api/network', (req, res) => {
  res.json(getNetworkInfo());
});

// Main page
app.get('/', (req, res) => {
  const data = getNetworkInfo();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Network Info Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 20px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }

        .title {
            font-size: 2.5rem;
            margin-bottom: 10px;
        }

        .subtitle {
            font-size: 1.2rem;
            opacity: 0.9;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }

        .card {
            background: rgba(255, 255, 255, 0.15);
            border-radius: 15px;
            padding: 20px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .card h3 {
            margin-bottom: 15px;
            font-size: 1.3rem;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .info-row:last-child {
            border-bottom: none;
        }

        .label {
            font-weight: 500;
            opacity: 0.9;
        }

        .value {
            font-family: 'Courier New', monospace;
            background: rgba(255, 255, 255, 0.1);
            padding: 2px 8px;
            border-radius: 4px;
        }

        .status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: bold;
        }

        .status.good { background: #48bb78; }
        .status.warning { background: #ed8936; }
        .status.error { background: #f56565; }

        .refresh-info {
            text-align: center;
            padding: 20px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            margin-top: 20px;
        }

        .refresh-button {
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.3);
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 1rem;
            margin: 10px;
        }

        .refresh-button:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        @media (max-width: 768px) {
            .grid { grid-template-columns: 1fr; }
            .title { font-size: 2rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 class="title">🚀 KubeVirt Live Migration Monitor</h1>
            <p class="subtitle">Host: ${data.hostname} | Uptime: ${Math.floor(data.uptime/3600)}h ${Math.floor((data.uptime%3600)/60)}m</p>
        </div>

        <div class="grid">
            <!-- Basic Network Info -->
            <div class="card">
                <h3>🔗 Network Configuration</h3>
                <div class="info-row">
                    <span class="label">Primary IP</span>
                    <span class="value">${data.primaryIP}</span>
                </div>
                <div class="info-row">
                    <span class="label">Gateway</span>
                    <span class="value">${data.gateway}</span>
                </div>
                <div class="info-row">
                    <span class="label">DNS Servers</span>
                    <span class="value">${data.dnsServers.length} configured</span>
                </div>
                <div class="info-row">
                    <span class="label">Platform</span>
                    <span class="value">${data.platform} (${data.arch})</span>
                </div>
            </div>

            <!-- Public Network Info -->
            <div class="card">
                <h3>🌍 Public Network</h3>
                <div class="info-row">
                    <span class="label">Public IP</span>
                    <span class="value">${data.publicIP}</span>
                </div>
                ${data.location ? `
                <div class="info-row">
                    <span class="label">Location</span>
                    <span class="value">${data.location.city}, ${data.location.region}</span>
                </div>
                <div class="info-row">
                    <span class="label">Country</span>
                    <span class="value">${data.location.country}</span>
                </div>
                <div class="info-row">
                    <span class="label">ISP</span>
                    <span class="value">${data.location.isp}</span>
                </div>
                <div class="info-row">
                    <span class="label">Timezone</span>
                    <span class="value">${data.location.timezone}</span>
                </div>` : ''}
            </div>

            <!-- Connectivity -->
            <div class="card">
                <h3>📡 Connectivity</h3>
                <div class="info-row">
                    <span class="label">Internet Latency</span>
                    <span class="value">
                        ${data.internetLatency ?
                            `<span class="status ${data.internetLatency < 50 ? 'good' : data.internetLatency < 100 ? 'warning' : 'error'}">${data.internetLatency}ms</span>` :
                            'N/A'}
                    </span>
                </div>
                <div class="info-row">
                    <span class="label">Last Updated</span>
                    <span class="value">${new Date(data.timestamp).toLocaleTimeString()}</span>
                </div>
            </div>
        </div>

        <!-- DNS Servers Detail -->
        ${data.dnsServers.length > 0 ? `
        <div class="card">
            <h3>🔍 DNS Servers</h3>
            ${data.dnsServers.map((dns, index) => `
                <div class="info-row">
                    <span class="label">DNS ${index + 1}</span>
                    <span class="value">${dns}</span>
                </div>
            `).join('')}
        </div>` : ''}

        <!-- Network Interfaces -->
        ${Object.keys(data.interfaces).length > 0 ? `
        <div class="card">
            <h3>🔧 Network Interfaces</h3>
            ${Object.entries(data.interfaces).map(([name, iface]) => `
                <div style="margin-bottom: 15px;">
                    <h4 style="color: #ffd700; margin-bottom: 8px;">${name}</h4>
                    <div class="info-row">
                        <span class="label">IP Address</span>
                        <span class="value">${iface.ip}</span>
                    </div>
                    <div class="info-row">
                        <span class="label">Netmask</span>
                        <span class="value">${iface.netmask}</span>
                    </div>
                    <div class="info-row">
                        <span class="label">MAC Address</span>
                        <span class="value">${iface.mac}</span>
                    </div>
                </div>
            `).join('')}
        </div>` : ''}

        <div class="refresh-info">
            <p><strong>Manual Refresh Dashboard</strong></p>
            <p>Click the button below to get the latest network information</p>
            <button class="refresh-button" onclick="window.location.reload()">🔄 Refresh Now</button>
            <button class="refresh-button" onclick="window.open('/api/network', '_blank')">📊 View API</button>
        </div>
    </div>
</body>
</html>`;

  res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Simple Network Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 API: http://localhost:${PORT}/api/network`);
  console.log(`💚 Health: http://localhost:${PORT}/health`);
});