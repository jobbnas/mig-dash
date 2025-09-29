const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(compression());

function safeExec(command, timeout = 3000) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (error) {
    return null;
  }
}

function discoverKubernetesServices() {
  const services = {
    cluster: {},
    serviceEndpoints: [],
    connectivity: {},
    clusterInfo: {}
  };

  try {
    // Check if we're in a Kubernetes environment
    const kubeHost = process.env.KUBERNETES_SERVICE_HOST;
    const kubePort = process.env.KUBERNETES_SERVICE_PORT || '443';

    if (kubeHost) {
      services.cluster.apiServer = `${kubeHost}:${kubePort}`;
      services.cluster.detected = true;

      // Test connectivity to API server
      const apiLatency = safeExec(`timeout 2 bash -c "(time curl -sk https://${kubeHost}:${kubePort}/healthz) 2>&1 | grep real | awk '{print $2}'" 2>/dev/null`);
      services.connectivity.apiServer = apiLatency ? apiLatency.replace('0m', '').replace('s', '') : null;
    }

    // Read service account info if available
    const saTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
    const saCertPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
    const saNamespacePath = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

    if (fs.existsSync(saTokenPath)) {
      services.clusterInfo.hasServiceAccount = true;

      if (fs.existsSync(saNamespacePath)) {
        const namespace = fs.readFileSync(saNamespacePath, 'utf8').trim();
        services.clusterInfo.namespace = namespace;
      }
    }

    // Discover common Kubernetes services through DNS
    const commonServices = [
      'kubernetes.default.svc.cluster.local',
      'kube-dns.kube-system.svc.cluster.local',
      'metrics-server.kube-system.svc.cluster.local',
      'prometheus.openshift-monitoring.svc.cluster.local',
      'router-default.openshift-ingress.svc.cluster.local',
      'console.openshift-console.svc.cluster.local',
      'oauth-openshift.openshift-authentication.svc.cluster.local'
    ];

    for (const service of commonServices) {
      const result = safeExec(`timeout 2 nslookup ${service} 2>/dev/null | grep "Address:"`, 1000);
      if (result) {
        const addresses = result.split('\n')
          .filter(line => line.includes('Address:') && !line.includes('#'))
          .map(line => line.split('Address:')[1]?.trim())
          .filter(Boolean);

        if (addresses.length > 0) {
          services.serviceEndpoints.push({
            name: service.split('.')[0],
            fqdn: service,
            addresses: addresses,
            namespace: service.includes('.') ? service.split('.')[1] : 'default',
            discovered: true
          });
        }
      }
    }

    // Check for OpenShift-specific services
    const openshiftCheck = safeExec('timeout 2 nslookup openshift.default.svc.cluster.local 2>/dev/null');
    services.clusterInfo.isOpenShift = !!openshiftCheck;

    // Discover services via environment variables (common in pods)
    const envServices = [];
    Object.keys(process.env).forEach(key => {
      if (key.endsWith('_SERVICE_HOST')) {
        const serviceName = key.replace('_SERVICE_HOST', '').toLowerCase().replace(/_/g, '-');
        const host = process.env[key];
        const portKey = `${key.replace('_HOST', '_PORT')}`;
        const port = process.env[portKey];

        if (host && port) {
          envServices.push({
            name: serviceName,
            host: host,
            port: port,
            endpoint: `${host}:${port}`,
            source: 'environment'
          });
        }
      }
    });

    services.serviceEndpoints.push(...envServices);

    // Test connectivity to discovered services
    services.serviceEndpoints.forEach(service => {
      if (service.addresses && service.addresses.length > 0) {
        const testAddress = service.addresses[0];
        // Simple connectivity test - ping if it's an IP
        if (/^\d+\.\d+\.\d+\.\d+$/.test(testAddress)) {
          const pingResult = safeExec(`timeout 1 ping -c 1 -W 1 ${testAddress} 2>/dev/null | grep "time=" | head -1`);
          if (pingResult) {
            const latency = pingResult.match(/time=([0-9.]+)/);
            service.latency = latency ? parseFloat(latency[1]) : null;
            service.reachable = true;
          } else {
            service.reachable = false;
          }
        }
      }
    });

  } catch (error) {
    console.error('Error discovering Kubernetes services:', error);
  }

  return services;
}

function discoverClusterEndpoints() {
  const endpoints = {
    internalEndpoints: [],
    externalEndpoints: [],
    migrationTargets: [],
    clusterMetadata: {}
  };

  try {
    // Discover internal cluster endpoints
    const internalDns = safeExec('grep search /etc/resolv.conf 2>/dev/null | cut -d" " -f2-');
    if (internalDns) {
      const domains = internalDns.split(' ').filter(Boolean);
      endpoints.clusterMetadata.searchDomains = domains;

      // Extract cluster domain (usually cluster.local)
      const clusterDomain = domains.find(d => d.includes('cluster.local'));
      if (clusterDomain) {
        endpoints.clusterMetadata.clusterDomain = clusterDomain;
      }
    }

    // Look for common OpenShift router patterns
    const routerPatterns = [
      'apps.cluster.local',
      '*.apps.cluster.local',
      'console-openshift-console.apps',
      'oauth-openshift.apps'
    ];

    // Check for external load balancer endpoints
    const publicIP = safeExec('curl -s --max-time 2 ifconfig.me 2>/dev/null');
    if (publicIP) {
      endpoints.externalEndpoints.push({
        type: 'public-ip',
        address: publicIP,
        description: 'Public IP address'
      });
    }

    // Check for cloud provider metadata endpoints that might indicate migration targets
    const cloudMetadata = discoverInfrastructureMetadata();
    if (cloudMetadata.provider) {
      endpoints.clusterMetadata.cloudProvider = cloudMetadata.provider;

      // Add potential migration targets based on cloud provider
      switch (cloudMetadata.provider) {
        case 'AWS':
          endpoints.migrationTargets.push({
            type: 'aws-region',
            current: cloudMetadata.region,
            potential: ['us-east-1', 'us-west-2', 'eu-west-1'].filter(r => r !== cloudMetadata.region)
          });
          break;
        case 'GCP':
          endpoints.migrationTargets.push({
            type: 'gcp-zone',
            current: cloudMetadata.zone,
            potential: ['us-central1', 'us-east1', 'europe-west1']
          });
          break;
        case 'Azure':
          endpoints.migrationTargets.push({
            type: 'azure-region',
            current: cloudMetadata.location,
            potential: ['eastus', 'westus2', 'northeurope']
          });
          break;
      }
    }

    // Test common OpenShift console endpoints
    const consoleEndpoints = [
      'console-openshift-console.apps',
      'oauth-openshift.apps',
      'prometheus-k8s-openshift-monitoring.apps'
    ];

    consoleEndpoints.forEach(endpoint => {
      const fullEndpoint = `${endpoint}.${endpoints.clusterMetadata.searchDomains?.[0] || 'cluster.local'}`;
      const testResult = safeExec(`timeout 2 nslookup ${fullEndpoint} 2>/dev/null`);
      if (testResult) {
        endpoints.internalEndpoints.push({
          name: endpoint.split('-')[0],
          fqdn: fullEndpoint,
          type: 'openshift-console',
          accessible: true
        });
      }
    });

  } catch (error) {
    console.error('Error discovering cluster endpoints:', error);
  }

  return endpoints;
}

function discoverVMEnvironment() {
  const vmInfo = {
    isVM: true,
    hostname: os.hostname(),
    environment: 'VM on KubeVirt',
    hypervisor: null
  };

  try {
    const dmiProduct = safeExec('cat /sys/class/dmi/id/product_name 2>/dev/null');
    const dmiVendor = safeExec('cat /sys/class/dmi/id/sys_vendor 2>/dev/null');

    if (dmiProduct || dmiVendor) {
      vmInfo.hypervisor = `${dmiVendor || ''} ${dmiProduct || ''}`.trim();
    }

    if (dmiProduct && dmiProduct.includes('KubeVirt')) {
      vmInfo.platform = 'KubeVirt';
    }
  } catch (e) {}

  try {
    const virtWhat = safeExec('systemd-detect-virt 2>/dev/null');
    if (virtWhat) {
      vmInfo.virtualization = virtWhat;
    }
  } catch (e) {}

  return vmInfo;
}

function discoverNetworkTopology() {
  const networkInfo = {};

  const primaryIP = safeExec('ip route get 1.1.1.1 2>/dev/null | grep -oP "src \\K\\S+"');
  const gateway = safeExec('ip route show default 2>/dev/null | grep -oP "via \\K\\S+"');

  const dnsServers = safeExec('grep nameserver /etc/resolv.conf 2>/dev/null | awk \'{print $2}\'');
  const dnsArray = dnsServers ? dnsServers.split('\n').filter(Boolean) : [];

  const searchDomains = safeExec('grep search /etc/resolv.conf 2>/dev/null | cut -d" " -f2-');
  const searchArray = searchDomains ? searchDomains.split(' ').filter(Boolean) : [];

  const routingTable = safeExec('ip route show 2>/dev/null | head -10');
  const routes = routingTable ? routingTable.split('\n').filter(Boolean) : [];

  const arpTable = safeExec('arp -a 2>/dev/null | head -5');
  const arpEntries = arpTable ? arpTable.split('\n').filter(Boolean) : [];

  const gatewayLatency = gateway ? safeExec(`ping -c 1 -W 1 ${gateway} 2>/dev/null | grep -oP "time=\\K[0-9.]+"`) : null;
  const internetLatency = safeExec('ping -c 1 -W 1 8.8.8.8 2>/dev/null | grep -oP "time=\\K[0-9.]+"');

  const clusterDnsLatency = dnsArray.length > 0 ?
    safeExec(`ping -c 1 -W 1 ${dnsArray[0]} 2>/dev/null | grep -oP "time=\\K[0-9.]+"`) : null;

  return {
    primaryIP,
    gateway,
    dnsServers: dnsArray,
    searchDomains: searchArray,
    routes: routes.slice(0, 5),
    arpEntries: arpEntries.slice(0, 3),
    latency: {
      internet: internetLatency ? parseFloat(internetLatency) : null,
      gateway: gatewayLatency ? parseFloat(gatewayLatency) : null,
      clusterDns: clusterDnsLatency ? parseFloat(clusterDnsLatency) : null
    }
  };
}

function discoverInfrastructureMetadata() {
  const metadata = {};

  const awsMetadata = safeExec('curl -s --max-time 2 http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null');
  if (awsMetadata && awsMetadata !== 'Not Found') {
    metadata.provider = 'AWS';
    metadata.instanceId = awsMetadata;
    metadata.zone = safeExec('curl -s --max-time 2 http://169.254.169.254/latest/meta-data/placement/availability-zone 2>/dev/null');
    metadata.region = safeExec('curl -s --max-time 2 http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null');
    metadata.instanceType = safeExec('curl -s --max-time 2 http://169.254.169.254/latest/meta-data/instance-type 2>/dev/null');
  }

  const gcpMetadata = safeExec('curl -s --max-time 2 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/id 2>/dev/null');
  if (gcpMetadata && gcpMetadata !== 'Not Found') {
    metadata.provider = 'GCP';
    metadata.instanceId = gcpMetadata;
    metadata.zone = safeExec('curl -s --max-time 2 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/zone 2>/dev/null');
    metadata.machineType = safeExec('curl -s --max-time 2 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/machine-type 2>/dev/null');
  }

  const azureMetadata = safeExec('curl -s --max-time 2 -H "Metadata:true" "http://169.254.169.254/metadata/instance/compute/vmId?api-version=2021-02-01&format=text" 2>/dev/null');
  if (azureMetadata && azureMetadata !== 'Not Found') {
    metadata.provider = 'Azure';
    metadata.vmId = azureMetadata;
    metadata.location = safeExec('curl -s --max-time 2 -H "Metadata:true" "http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text" 2>/dev/null');
    metadata.vmSize = safeExec('curl -s --max-time 2 -H "Metadata:true" "http://169.254.169.254/metadata/instance/compute/vmSize?api-version=2021-02-01&format=text" 2>/dev/null');
  }

  if (!metadata.provider) {
    const dmiInfo = safeExec('dmidecode -s system-product-name 2>/dev/null');
    if (dmiInfo) {
      if (dmiInfo.includes('VMware')) metadata.provider = 'VMware';
      else if (dmiInfo.includes('KVM')) metadata.provider = 'KVM';
      else if (dmiInfo.includes('VirtualBox')) metadata.provider = 'VirtualBox';
      else metadata.provider = 'Unknown';
    }
  }

  return metadata;
}

function discoverNetworkFingerprint() {
  const fingerprint = {};

  const dnsSearchDomains = safeExec('grep search /etc/resolv.conf 2>/dev/null | cut -d" " -f2-');
  if (dnsSearchDomains) {
    fingerprint.searchDomains = dnsSearchDomains.split(' ').filter(Boolean);
  }

  const localSubnets = safeExec('ip route show scope link 2>/dev/null');
  if (localSubnets) {
    fingerprint.localNetworks = localSubnets.split('\n').filter(Boolean).slice(0, 3);
  }

  try {
    const defaultNS = safeExec('host kubernetes.default 2>/dev/null | grep "has address"');
    if (defaultNS) {
      fingerprint.kubernetesResolvable = true;
    }
  } catch (e) {}

  try {
    const openshiftConsole = safeExec('host console-openshift-console.apps 2>/dev/null | grep "has address"');
    if (openshiftConsole) {
      fingerprint.openshiftConsoleResolvable = true;
    }
  } catch (e) {}

  const ntpServers = safeExec('grep -E "^server|^pool" /etc/chrony.conf /etc/ntp.conf 2>/dev/null | head -3');
  if (ntpServers) {
    fingerprint.timeServers = ntpServers.split('\n').filter(Boolean);
  }

  return fingerprint;
}

function performServiceHealthChecks(services) {
  const healthChecks = {
    clusterApiHealth: null,
    serviceConnectivity: [],
    migrationReadiness: false,
    criticalServicesUp: 0,
    totalServicesChecked: 0
  };

  try {
    // Check API server health
    if (services.cluster.apiServer) {
      const healthResult = safeExec(`timeout 3 curl -sk https://${services.cluster.apiServer}/healthz 2>/dev/null`);
      healthChecks.clusterApiHealth = healthResult === 'ok';
    }

    // Test service connectivity
    services.serviceEndpoints.forEach(service => {
      healthChecks.totalServicesChecked++;

      let serviceHealth = {
        name: service.name,
        namespace: service.namespace || 'default',
        healthy: false,
        latency: null,
        lastCheck: new Date().toISOString()
      };

      if (service.addresses && service.addresses.length > 0) {
        const testAddr = service.addresses[0];

        // Test connectivity with ping
        const pingResult = safeExec(`timeout 1 ping -c 1 -W 1 ${testAddr} 2>/dev/null | grep "time="`);
        if (pingResult) {
          const latencyMatch = pingResult.match(/time=([0-9.]+)/);
          serviceHealth.latency = latencyMatch ? parseFloat(latencyMatch[1]) : null;
          serviceHealth.healthy = true;
          healthChecks.criticalServicesUp++;
        }

        // For HTTP services, try a basic connection test
        if (service.name.includes('console') || service.name.includes('oauth') || service.name.includes('prometheus')) {
          const httpTest = safeExec(`timeout 2 curl -sk --connect-timeout 1 -I http://${testAddr} 2>/dev/null | head -1`);
          if (httpTest && httpTest.includes('HTTP')) {
            serviceHealth.httpAccessible = true;
          }
        }
      }

      healthChecks.serviceConnectivity.push(serviceHealth);
    });

    // Determine migration readiness
    const healthyPercentage = healthChecks.totalServicesChecked > 0
      ? (healthChecks.criticalServicesUp / healthChecks.totalServicesChecked) * 100
      : 0;

    healthChecks.migrationReadiness = healthyPercentage >= 75 && healthChecks.clusterApiHealth !== false;

  } catch (error) {
    console.error('Error performing service health checks:', error);
  }

  return healthChecks;
}

function detectMigrationEvents() {
  const events = {
    migrationDetected: false,
    events: [],
    clusterChanges: {},
    networkChanges: {}
  };

  try {
    // Check for recent dmesg entries that might indicate migration
    const dmesgOutput = safeExec('dmesg | tail -50 | grep -i "virtio\\|migration\\|suspend\\|resume" 2>/dev/null');
    if (dmesgOutput) {
      const migrationKeywords = ['migration', 'suspend', 'resume', 'virtio', 'balloon'];
      const lines = dmesgOutput.split('\n').filter(Boolean);

      lines.forEach(line => {
        migrationKeywords.forEach(keyword => {
          if (line.toLowerCase().includes(keyword)) {
            events.migrationDetected = true;
            events.events.push({
              timestamp: new Date().toISOString(),
              type: 'system',
              message: line.trim(),
              keyword: keyword
            });
          }
        });
      });
    }

    // Check for network interface changes
    const currentInterfaces = Object.keys(os.networkInterfaces());
    const storedInterfaces = process.env.STORED_INTERFACES ? process.env.STORED_INTERFACES.split(',') : [];

    if (storedInterfaces.length > 0) {
      const interfaceChanges = {
        added: currentInterfaces.filter(iface => !storedInterfaces.includes(iface)),
        removed: storedInterfaces.filter(iface => !currentInterfaces.includes(iface))
      };

      if (interfaceChanges.added.length > 0 || interfaceChanges.removed.length > 0) {
        events.migrationDetected = true;
        events.networkChanges = interfaceChanges;
        events.events.push({
          timestamp: new Date().toISOString(),
          type: 'network',
          message: `Network interfaces changed: +${interfaceChanges.added.length}, -${interfaceChanges.removed.length}`,
          details: interfaceChanges
        });
      }
    }

    // Store current interfaces for next check
    process.env.STORED_INTERFACES = currentInterfaces.join(',');

    // Check for changes in cluster endpoints
    const currentDns = safeExec('grep nameserver /etc/resolv.conf 2>/dev/null | awk \'{print $2}\'');
    const storedDns = process.env.STORED_DNS_SERVERS;

    if (storedDns && currentDns !== storedDns) {
      events.migrationDetected = true;
      events.clusterChanges.dnsServers = {
        previous: storedDns.split('\n'),
        current: currentDns ? currentDns.split('\n') : []
      };
      events.events.push({
        timestamp: new Date().toISOString(),
        type: 'cluster',
        message: 'DNS servers changed - possible cluster migration',
        details: events.clusterChanges.dnsServers
      });
    }

    process.env.STORED_DNS_SERVERS = currentDns || '';

  } catch (error) {
    console.error('Error detecting migration events:', error);
  }

  return events;
}

function getMigrationSensitiveData() {
  const startTime = Date.now();

  const publicIP = safeExec('curl -s --max-time 2 ifconfig.me 2>/dev/null || curl -s --max-time 2 ipinfo.io/ip 2>/dev/null');

  let locationData = null;
  if (publicIP) {
    try {
      const locationJson = safeExec(`curl -s --max-time 3 "https://ipapi.co/${publicIP}/json/" 2>/dev/null`);
      locationData = JSON.parse(locationJson || '{}');
    } catch (e) {
      locationData = null;
    }
  }

  const vmInfo = discoverVMEnvironment();
  const networkInfo = discoverNetworkTopology();
  const infraMetadata = discoverInfrastructureMetadata();
  const networkFingerprint = discoverNetworkFingerprint();

  // New service discovery functions
  const kubernetesServices = discoverKubernetesServices();
  const clusterEndpoints = discoverClusterEndpoints();
  const serviceHealth = performServiceHealthChecks(kubernetesServices);
  const migrationEvents = detectMigrationEvents();

  const networkInterfaces = os.networkInterfaces();
  const activeInterfaces = {};
  Object.keys(networkInterfaces).forEach(name => {
    const interfaces = networkInterfaces[name].filter(iface =>
      iface.family === 'IPv4' && !iface.internal
    );
    if (interfaces.length > 0) {
      activeInterfaces[name] = interfaces[0];
    }
  });

  const memInfo = {
    total: Math.round(os.totalmem() / 1024 / 1024),
    free: Math.round(os.freemem() / 1024 / 1024),
    used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
    usage: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(1)
  };

  const uptime = process.uptime();
  const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;

  return {
    timestamp: new Date().toISOString(),
    collectionTime: Date.now() - startTime,

    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: Math.floor(uptime),
      uptimeFormatted,
      loadAvg: os.loadavg().map(l => Number(l.toFixed(2)))
    },

    memory: memInfo,

    network: {
      ...networkInfo,
      publicIP,
      interfaces: activeInterfaces
    },

    location: locationData ? {
      city: locationData.city || 'Unknown',
      region: locationData.region || 'Unknown',
      country: locationData.country_name || 'Unknown',
      isp: locationData.org || 'Unknown',
      timezone: locationData.timezone || 'Unknown',
      coordinates: locationData.latitude && locationData.longitude ?
        `${locationData.latitude},${locationData.longitude}` : null
    } : null,

    vm: vmInfo,

    infrastructure: infraMetadata,

    networkFingerprint: networkFingerprint,

    // Service Discovery Data
    kubernetesServices: kubernetesServices,

    clusterEndpoints: clusterEndpoints,

    serviceHealth: serviceHealth,

    migrationEvents: migrationEvents
  };
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/metrics', (req, res) => {
  try {
    const data = getMigrationSensitiveData();
    res.json(data);
  } catch (error) {
    console.error('Error collecting metrics:', error);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

app.get('/', (req, res) => {
  try {
    const data = getMigrationSensitiveData();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VM Migration Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
            overflow-x: hidden;
        }

        .background-animation {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background:
                radial-gradient(circle at 20% 80%, rgba(120, 119, 198, 0.2) 0%, transparent 50%),
                radial-gradient(circle at 80% 20%, rgba(255, 119, 198, 0.2) 0%, transparent 50%),
                radial-gradient(circle at 40% 40%, rgba(120, 219, 255, 0.2) 0%, transparent 50%);
            animation: float 15s ease-in-out infinite;
            z-index: -1;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            33% { transform: translateY(-20px) rotate(1deg); }
            66% { transform: translateY(-10px) rotate(-0.5deg); }
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            position: relative;
            z-index: 1;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 25px;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }

        h1 {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 15px;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }

        .status-banner {
            background: rgba(255, 255, 255, 0.15);
            padding: 15px 25px;
            border-radius: 15px;
            font-weight: 500;
            font-size: 1.1rem;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .location-card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 25px;
            margin-bottom: 25px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }

        .location-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-top: 15px;
        }

        .location-item {
            text-align: center;
            padding: 15px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }

        .location-icon {
            font-size: 2rem;
            margin-bottom: 8px;
            display: block;
        }

        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }

        .card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 25px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        }

        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
            border-color: rgba(255, 255, 255, 0.3);
        }

        .card h3 {
            font-size: 1.3rem;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .metric-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .metric-row:last-child {
            border-bottom: none;
        }

        .metric-label {
            font-weight: 500;
            opacity: 0.9;
        }

        .metric-value {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 500;
            text-align: right;
        }

        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 500;
        }

        .status-good {
            background: rgba(76, 175, 80, 0.3);
            border: 1px solid rgba(76, 175, 80, 0.5);
        }

        .status-warning {
            background: rgba(255, 152, 0, 0.3);
            border: 1px solid rgba(255, 152, 0, 0.5);
        }

        .status-error {
            background: rgba(244, 67, 54, 0.3);
            border: 1px solid rgba(244, 67, 54, 0.5);
        }

        .migration-alert {
            position: fixed;
            top: 80px;
            right: 20px;
            background: linear-gradient(135deg, #ff6b6b, #ffa726);
            color: white;
            padding: 15px 20px;
            border-radius: 15px;
            border: 2px solid #ff4757;
            box-shadow: 0 10px 30px rgba(255, 107, 107, 0.4);
            z-index: 1000;
            animation: pulse-alert 2s infinite;
            max-width: 300px;
        }

        .migration-alert h4 {
            margin: 0 0 8px 0;
            font-size: 1.1rem;
        }

        .migration-alert p {
            margin: 0;
            font-size: 0.9rem;
            opacity: 0.9;
        }

        @keyframes pulse-alert {
            0% { transform: scale(1); box-shadow: 0 10px 30px rgba(255, 107, 107, 0.4); }
            50% { transform: scale(1.05); box-shadow: 0 15px 40px rgba(255, 107, 107, 0.6); }
            100% { transform: scale(1); box-shadow: 0 10px 30px rgba(255, 107, 107, 0.4); }
        }

        .cluster-changes {
            background: rgba(255, 193, 7, 0.2);
            border: 1px solid rgba(255, 193, 7, 0.6);
            border-radius: 10px;
            padding: 15px;
            margin: 15px 0;
            backdrop-filter: blur(10px);
        }

        .cluster-changes h4 {
            color: #ffc107;
            margin: 0 0 10px 0;
            font-size: 1rem;
        }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 8px;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #8BC34A);
            border-radius: 4px;
            transition: width 0.5s ease;
        }

        .timestamp {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(10px);
            padding: 10px 15px;
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.8rem;
            z-index: 1000;
        }

        .network-interfaces {
            margin-top: 15px;
        }

        .interface-item {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin: 10px 0;
            backdrop-filter: blur(10px);
        }

        .interface-name {
            font-weight: 600;
            margin-bottom: 8px;
            color: #FFD700;
        }

        .footer {
            text-align: center;
            margin-top: 30px;
            padding: 20px;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(20px);
            border-radius: 15px;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        @media (max-width: 768px) {
            h1 { font-size: 2rem; }
            .metrics-grid { grid-template-columns: 1fr; }
            .location-grid { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="background-animation"></div>
    <div class="timestamp">🕒 ${new Date(data.timestamp).toLocaleTimeString()}</div>

    ${data.migrationEvents?.migrationDetected ? `
    <div class="migration-alert">
        <h4>🚨 Live Migration Active!</h4>
        <p>Detected ${data.migrationEvents.events?.length || 0} migration events</p>
        ${data.migrationEvents.networkChanges?.added?.length > 0 || data.migrationEvents.networkChanges?.removed?.length > 0 ?
            `<p>Network interfaces changed</p>` : ''}
        ${data.migrationEvents.clusterChanges?.dnsServers ?
            `<p>Cluster DNS servers changed</p>` : ''}
    </div>` : ''}

    <div class="container">
        <div class="header">
            <h1>🚀 KubeVirt Live Migration Monitor</h1>
            <div class="status-banner">
                <strong>VM:</strong> ${data.system.hostname} |
                <strong>Uptime:</strong> ${data.system.uptimeFormatted} |
                <strong>Collection:</strong> ${data.collectionTime}ms
            </div>
        </div>

        <!-- Migration Status Banner -->
        <div class="location-card" style="background: ${data.migrationEvents?.migrationDetected ? 'linear-gradient(135deg, #ff6b6b 0%, #ffa726 50%)' : 'linear-gradient(135deg, #4CAF50 0%, #8BC34A 50%)'};">
            <h3>${data.migrationEvents?.migrationDetected ? '🚨 LIVE MIGRATION DETECTED' : '✅ CLUSTER CONNECTIVITY STABLE'}</h3>
            <div class="location-grid">
                <div class="location-item">
                    <span class="location-icon">☸️</span>
                    <div><strong>Cluster API</strong></div>
                    <div style="font-size: 0.9rem;">${data.kubernetesServices?.cluster.apiServer || 'Not Detected'}</div>
                </div>
                <div class="location-item">
                    <span class="location-icon">🌍</span>
                    <div><strong>Location</strong></div>
                    <div>${data.location?.city || 'Unknown'}, ${data.location?.region || 'Unknown'}</div>
                </div>
                <div class="location-item">
                    <span class="location-icon">🔍</span>
                    <div><strong>Services</strong></div>
                    <div>${data.kubernetesServices?.serviceEndpoints?.length || 0} discovered</div>
                </div>
                <div class="location-item">
                    <span class="location-icon">🏥</span>
                    <div><strong>Health</strong></div>
                    <div>${data.serviceHealth?.totalServicesChecked > 0 ? Math.round((data.serviceHealth.criticalServicesUp / data.serviceHealth.totalServicesChecked) * 100) : 0}%</div>
                </div>
                ${data.migrationEvents?.migrationDetected ? `
                <div class="location-item">
                    <span class="location-icon">⚠️</span>
                    <div><strong>Events</strong></div>
                    <div>${data.migrationEvents.events?.length || 0} detected</div>
                </div>` : ''}
            </div>
        </div>

        ${data.location ? `
        <div class="location-card">
            <h3>📍 Current Location & Network Provider</h3>
            <div class="location-grid">
                <div class="location-item">
                    <span class="location-icon">🌆</span>
                    <div><strong>${data.location.city}</strong></div>
                    <div>${data.location.region}</div>
                </div>
                <div class="location-item">
                    <span class="location-icon">🏳️</span>
                    <div><strong>${data.location.country}</strong></div>
                    <div>${data.location.timezone}</div>
                </div>
                <div class="location-item">
                    <span class="location-icon">🌐</span>
                    <div><strong>ISP</strong></div>
                    <div style="font-size: 0.9rem;">${data.location.isp}</div>
                </div>
                <div class="location-item">
                    <span class="location-icon">📡</span>
                    <div><strong>Public IP</strong></div>
                    <div>${data.network.publicIP || 'N/A'}</div>
                </div>
            </div>
        </div>` : ''}

        <div class="metrics-grid">
            <!-- PRIORITY: Network Infrastructure (Changes During Migration) -->
            <div class="card">
                <h3>🌐 Network Infrastructure</h3>
                <div class="metric-row">
                    <span class="metric-label">Primary IP</span>
                    <span class="metric-value">${data.network.primaryIP || 'N/A'}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Gateway</span>
                    <span class="metric-value">${data.network.gateway || 'N/A'}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">DNS Servers</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.network.dnsServers.length} active</span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Search Domains</span>
                    <span class="metric-value">${data.network.searchDomains?.length || 0} configured</span>
                </div>
                ${data.network.latency?.clusterDns ? `
                <div class="metric-row">
                    <span class="metric-label">Cluster DNS Latency</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.network.latency.clusterDns < 5 ? 'status-good' : data.network.latency.clusterDns < 20 ? 'status-warning' : 'status-error'}">
                            ${data.network.latency.clusterDns}ms
                        </span>
                    </span>
                </div>` : ''}
            </div>

            <!-- PRIORITY: Kubernetes Cluster Context (Changes During Migration) -->
            ${data.kubernetesServices?.cluster.detected ? `
            <div class="card">
                <h3>☸️ OpenShift Cluster</h3>
                <div class="metric-row">
                    <span class="metric-label">API Server</span>
                    <span class="metric-value" style="font-size: 0.85rem;">${data.kubernetesServices.cluster.apiServer}</span>
                </div>
                ${data.kubernetesServices.clusterInfo.namespace ? `
                <div class="metric-row">
                    <span class="metric-label">Namespace</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.kubernetesServices.clusterInfo.namespace}</span>
                    </span>
                </div>` : ''}
                <div class="metric-row">
                    <span class="metric-label">OpenShift Platform</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.kubernetesServices.clusterInfo.isOpenShift ? 'status-good' : 'status-warning'}">
                            ${data.kubernetesServices.clusterInfo.isOpenShift ? '✅ Detected' : '❌ Not Found'}
                        </span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Services Discovered</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.kubernetesServices.serviceEndpoints?.length || 0} services</span>
                    </span>
                </div>
                ${data.serviceHealth?.clusterApiHealth !== null ? `
                <div class="metric-row">
                    <span class="metric-label">API Health</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.serviceHealth.clusterApiHealth ? 'status-good' : 'status-error'}">
                            ${data.serviceHealth.clusterApiHealth ? '✅ Healthy' : '❌ Unhealthy'}
                        </span>
                    </span>
                </div>` : ''}
            </div>` : `
            <div class="card">
                <h3>☸️ Kubernetes Detection</h3>
                <div class="metric-row">
                    <span class="metric-label">Cluster Status</span>
                    <span class="metric-value">
                        <span class="status-indicator status-error">❌ Not in Kubernetes</span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Environment</span>
                    <span class="metric-value">Standalone VM</span>
                </div>
            </div>`}

            <!-- PRIORITY: Migration Status & Health -->
            ${data.serviceHealth ? `
            <div class="card">
                <h3>🏥 Migration Readiness</h3>
                <div class="metric-row">
                    <span class="metric-label">Ready for Migration</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.serviceHealth.migrationReadiness ? 'status-good' : 'status-error'}">
                            ${data.serviceHealth.migrationReadiness ? '✅ Ready' : '❌ Not Ready'}
                        </span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Services Healthy</span>
                    <span class="metric-value">${data.serviceHealth.criticalServicesUp}/${data.serviceHealth.totalServicesChecked}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Health Percentage</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.serviceHealth.totalServicesChecked > 0 && (data.serviceHealth.criticalServicesUp / data.serviceHealth.totalServicesChecked) >= 0.75 ? 'status-good' : 'status-warning'}">
                            ${data.serviceHealth.totalServicesChecked > 0 ?
                                `${Math.round((data.serviceHealth.criticalServicesUp / data.serviceHealth.totalServicesChecked) * 100)}%` : 'N/A'}
                        </span>
                    </span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${data.serviceHealth.totalServicesChecked > 0 ?
                        Math.round((data.serviceHealth.criticalServicesUp / data.serviceHealth.totalServicesChecked) * 100) : 0}%"></div>
                </div>
            </div>` : ''}

            <!-- Secondary: System Info (Static during migration) -->
            <div class="card">
                <h3>🖥️ VM Status</h3>
                <div class="metric-row">
                    <span class="metric-label">Hostname</span>
                    <span class="metric-value">${data.system.hostname}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Platform</span>
                    <span class="metric-value">${data.system.platform} (${data.system.arch})</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Uptime (Preserved)</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.system.uptimeFormatted}</span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Load Average</span>
                    <span class="metric-value">${data.system.loadAvg.join(' • ')}</span>
                </div>
            </div>

            <div class="card">
                <h3>💾 Memory Usage</h3>
                <div class="metric-row">
                    <span class="metric-label">Total</span>
                    <span class="metric-value">${data.memory.total} MB</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Used</span>
                    <span class="metric-value">${data.memory.used} MB</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Free</span>
                    <span class="metric-value">${data.memory.free} MB</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Usage</span>
                    <span class="metric-value">${data.memory.usage}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${data.memory.usage}%"></div>
                </div>
            </div>

            <div class="card">
                <h3>🌐 Network Analysis</h3>
                <div class="metric-row">
                    <span class="metric-label">Primary IP</span>
                    <span class="metric-value">${data.network.primaryIP || 'N/A'}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Gateway</span>
                    <span class="metric-value">${data.network.gateway || 'N/A'}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Internet Latency</span>
                    <span class="metric-value">
                        ${data.network.latency?.internet ? `
                            <span class="status-indicator ${data.network.latency.internet < 50 ? 'status-good' : data.network.latency.internet < 100 ? 'status-warning' : 'status-error'}">
                                ${data.network.latency.internet}ms
                            </span>
                        ` : 'N/A'}
                    </span>
                </div>
                ${data.network.latency?.gateway ? `
                <div class="metric-row">
                    <span class="metric-label">Gateway Latency</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.network.latency.gateway < 5 ? 'status-good' : data.network.latency.gateway < 20 ? 'status-warning' : 'status-error'}">
                            ${data.network.latency.gateway}ms
                        </span>
                    </span>
                </div>` : ''}
                ${data.network.latency?.clusterDns ? `
                <div class="metric-row">
                    <span class="metric-label">Cluster DNS Latency</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.network.latency.clusterDns < 5 ? 'status-good' : data.network.latency.clusterDns < 20 ? 'status-warning' : 'status-error'}">
                            ${data.network.latency.clusterDns}ms
                        </span>
                    </span>
                </div>` : ''}
                <div class="metric-row">
                    <span class="metric-label">DNS Servers</span>
                    <span class="metric-value">${data.network.dnsServers.length} configured</span>
                </div>
            </div>

            <div class="card">
                <h3>🖥️ Virtual Machine</h3>
                <div class="metric-row">
                    <span class="metric-label">Environment</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.vm.environment}</span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Hostname</span>
                    <span class="metric-value">${data.vm.hostname}</span>
                </div>
                ${data.vm.hypervisor ? `
                <div class="metric-row">
                    <span class="metric-label">Hypervisor</span>
                    <span class="metric-value">${data.vm.hypervisor}</span>
                </div>` : ''}
                ${data.vm.virtualization ? `
                <div class="metric-row">
                    <span class="metric-label">Virtualization</span>
                    <span class="metric-value">${data.vm.virtualization}</span>
                </div>` : ''}
                ${data.vm.platform ? `
                <div class="metric-row">
                    <span class="metric-label">Platform</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.vm.platform}</span>
                    </span>
                </div>` : ''}
            </div>

            ${Object.keys(data.infrastructure).length > 0 ? `
            <div class="card">
                <h3>🏗️ Infrastructure</h3>
                ${data.infrastructure.provider ? `
                <div class="metric-row">
                    <span class="metric-label">Cloud Provider</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.infrastructure.provider}</span>
                    </span>
                </div>` : ''}
                ${data.infrastructure.zone || data.infrastructure.location ? `
                <div class="metric-row">
                    <span class="metric-label">Zone/Location</span>
                    <span class="metric-value">${data.infrastructure.zone || data.infrastructure.location}</span>
                </div>` : ''}
                ${data.infrastructure.region ? `
                <div class="metric-row">
                    <span class="metric-label">Region</span>
                    <span class="metric-value">${data.infrastructure.region}</span>
                </div>` : ''}
                ${data.infrastructure.instanceId || data.infrastructure.vmId ? `
                <div class="metric-row">
                    <span class="metric-label">Instance ID</span>
                    <span class="metric-value">${data.infrastructure.instanceId || data.infrastructure.vmId}</span>
                </div>` : ''}
                ${data.infrastructure.instanceType || data.infrastructure.machineType || data.infrastructure.vmSize ? `
                <div class="metric-row">
                    <span class="metric-label">Instance Type</span>
                    <span class="metric-value">${data.infrastructure.instanceType || data.infrastructure.machineType || data.infrastructure.vmSize}</span>
                </div>` : ''}
            </div>` : ''}

            ${Object.keys(data.networkFingerprint).length > 0 ? `
            <div class="card">
                <h3>🔍 Network Fingerprint</h3>
                ${data.networkFingerprint.searchDomains?.length > 0 ? `
                <div class="metric-row">
                    <span class="metric-label">Search Domains</span>
                    <span class="metric-value">${data.networkFingerprint.searchDomains.join(', ')}</span>
                </div>` : ''}
                ${data.networkFingerprint.kubernetesResolvable ? `
                <div class="metric-row">
                    <span class="metric-label">Kubernetes Resolvable</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">✅ Yes</span>
                    </span>
                </div>` : ''}
                ${data.networkFingerprint.openshiftConsoleResolvable ? `
                <div class="metric-row">
                    <span class="metric-label">OpenShift Console</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">✅ Resolvable</span>
                    </span>
                </div>` : ''}
                ${data.networkFingerprint.timeServers?.length > 0 ? `
                <div class="metric-row">
                    <span class="metric-label">Time Servers</span>
                    <span class="metric-value">${data.networkFingerprint.timeServers.length} configured</span>
                </div>` : ''}
                ${data.networkFingerprint.localNetworks?.length > 0 ? `
                <div class="metric-row">
                    <span class="metric-label">Local Networks</span>
                    <span class="metric-value">${data.networkFingerprint.localNetworks.length} routes</span>
                </div>` : ''}
            </div>` : ''}

            ${data.kubernetesServices?.cluster.detected ? `
            <div class="card">
                <h3>☸️ Kubernetes Cluster</h3>
                <div class="metric-row">
                    <span class="metric-label">API Server</span>
                    <span class="metric-value">${data.kubernetesServices.cluster.apiServer}</span>
                </div>
                ${data.kubernetesServices.clusterInfo.namespace ? `
                <div class="metric-row">
                    <span class="metric-label">Namespace</span>
                    <span class="metric-value">
                        <span class="status-indicator status-good">${data.kubernetesServices.clusterInfo.namespace}</span>
                    </span>
                </div>` : ''}
                <div class="metric-row">
                    <span class="metric-label">OpenShift Detected</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.kubernetesServices.clusterInfo.isOpenShift ? 'status-good' : 'status-warning'}">
                            ${data.kubernetesServices.clusterInfo.isOpenShift ? '✅ Yes' : '❌ No'}
                        </span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Service Account</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.kubernetesServices.clusterInfo.hasServiceAccount ? 'status-good' : 'status-warning'}">
                            ${data.kubernetesServices.clusterInfo.hasServiceAccount ? '✅ Available' : '❌ Not Found'}
                        </span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Discovered Services</span>
                    <span class="metric-value">${data.kubernetesServices.serviceEndpoints?.length || 0}</span>
                </div>
            </div>` : ''}

            ${data.serviceHealth ? `
            <div class="card">
                <h3>🏥 Service Health</h3>
                <div class="metric-row">
                    <span class="metric-label">Migration Ready</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.serviceHealth.migrationReadiness ? 'status-good' : 'status-error'}">
                            ${data.serviceHealth.migrationReadiness ? '✅ Ready' : '❌ Not Ready'}
                        </span>
                    </span>
                </div>
                ${data.serviceHealth.clusterApiHealth !== null ? `
                <div class="metric-row">
                    <span class="metric-label">API Server Health</span>
                    <span class="metric-value">
                        <span class="status-indicator ${data.serviceHealth.clusterApiHealth ? 'status-good' : 'status-error'}">
                            ${data.serviceHealth.clusterApiHealth ? '✅ Healthy' : '❌ Unhealthy'}
                        </span>
                    </span>
                </div>` : ''}
                <div class="metric-row">
                    <span class="metric-label">Services Up</span>
                    <span class="metric-value">${data.serviceHealth.criticalServicesUp}/${data.serviceHealth.totalServicesChecked}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Health Percentage</span>
                    <span class="metric-value">
                        ${data.serviceHealth.totalServicesChecked > 0 ?
                            `${Math.round((data.serviceHealth.criticalServicesUp / data.serviceHealth.totalServicesChecked) * 100)}%` : 'N/A'}
                    </span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${data.serviceHealth.totalServicesChecked > 0 ?
                        Math.round((data.serviceHealth.criticalServicesUp / data.serviceHealth.totalServicesChecked) * 100) : 0}%"></div>
                </div>
            </div>` : ''}

            ${data.migrationEvents?.migrationDetected ? `
            <div class="card">
                <h3>🚨 Migration Events</h3>
                <div class="metric-row">
                    <span class="metric-label">Migration Detected</span>
                    <span class="metric-value">
                        <span class="status-indicator status-warning">⚠️ Active</span>
                    </span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Recent Events</span>
                    <span class="metric-value">${data.migrationEvents.events?.length || 0}</span>
                </div>
                ${data.migrationEvents.networkChanges?.added?.length > 0 || data.migrationEvents.networkChanges?.removed?.length > 0 ? `
                <div class="metric-row">
                    <span class="metric-label">Network Changes</span>
                    <span class="metric-value">
                        +${data.migrationEvents.networkChanges.added?.length || 0}
                        -${data.migrationEvents.networkChanges.removed?.length || 0}
                    </span>
                </div>` : ''}
                ${data.migrationEvents.clusterChanges?.dnsServers ? `
                <div class="metric-row">
                    <span class="metric-label">DNS Changes</span>
                    <span class="metric-value">
                        <span class="status-indicator status-warning">⚠️ Detected</span>
                    </span>
                </div>` : ''}
            </div>` : ''}
        </div>

        <!-- CRITICAL: DNS & Cluster Discovery (Primary Migration Indicators) -->
        ${data.network.dnsServers.length > 0 ? `
        <div class="card" style="margin-top: 20px; border: 2px solid #4CAF50;">
            <h3>🔍 Cluster Network Discovery</h3>

            <div class="cluster-changes">
                <h4>📡 DNS Servers (Migration Sensitive)</h4>
                ${data.network.dnsServers.slice(0, 3).map((dns, index) => `
                    <div class="metric-row">
                        <span class="metric-label">Primary DNS ${index + 1}</span>
                        <span class="metric-value">
                            <span class="status-indicator status-good">${dns}</span>
                        </span>
                    </div>
                `).join('')}
            </div>

            ${data.network.searchDomains?.length > 0 ? `
            <div class="cluster-changes">
                <h4>🏷️ Cluster Domains (Will Change)</h4>
                ${data.network.searchDomains.slice(0, 3).map(domain => `
                    <div class="metric-row">
                        <span class="metric-label">Search Domain</span>
                        <span class="metric-value">
                            <span class="status-indicator ${domain.includes('cluster.local') ? 'status-good' : 'status-warning'}">${domain}</span>
                        </span>
                    </div>
                `).join('')}
            </div>` : ''}

            ${data.kubernetesServices?.serviceEndpoints?.length > 0 ? `
            <div class="cluster-changes">
                <h4>☸️ Critical OpenShift Services</h4>
                ${data.kubernetesServices.serviceEndpoints
                    .filter(service => service.name.includes('kubernetes') || service.name.includes('console') || service.name.includes('oauth'))
                    .slice(0, 4).map(service => `
                    <div class="metric-row">
                        <span class="metric-label">${service.name}</span>
                        <span class="metric-value">
                            <span class="status-indicator ${service.reachable ? 'status-good' : service.reachable === false ? 'status-error' : 'status-warning'}">
                                ${service.addresses ? service.addresses[0] : service.endpoint || 'Discovered'}
                            </span>
                        </span>
                    </div>
                `).join('')}
            </div>` : ''}
        </div>` : ''}

        ${Object.keys(data.network.interfaces).length > 0 ? `
        <div class="card" style="margin-top: 20px;">
            <h3>🔧 Network Interfaces</h3>
            <div class="network-interfaces">
                ${Object.entries(data.network.interfaces).map(([name, iface]) => `
                    <div class="interface-item">
                        <div class="interface-name">${name}</div>
                        <div class="metric-row">
                            <span class="metric-label">IP Address</span>
                            <span class="metric-value">${iface.address}</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">Netmask</span>
                            <span class="metric-value">${iface.netmask}</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">MAC Address</span>
                            <span class="metric-value">${iface.mac}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>` : ''}

        ${data.kubernetesServices?.serviceEndpoints?.length > 0 ? `
        <div class="card" style="margin-top: 20px;">
            <h3>🔍 Discovered Services</h3>
            <div class="network-interfaces">
                ${data.kubernetesServices.serviceEndpoints.slice(0, 8).map(service => `
                    <div class="interface-item">
                        <div class="interface-name">${service.name} ${service.namespace ? `(${service.namespace})` : ''}</div>
                        ${service.fqdn ? `
                        <div class="metric-row">
                            <span class="metric-label">FQDN</span>
                            <span class="metric-value" style="font-size: 0.85rem;">${service.fqdn}</span>
                        </div>` : ''}
                        ${service.addresses?.length > 0 ? `
                        <div class="metric-row">
                            <span class="metric-label">Address</span>
                            <span class="metric-value">${service.addresses[0]}</span>
                        </div>` : ''}
                        ${service.endpoint ? `
                        <div class="metric-row">
                            <span class="metric-label">Endpoint</span>
                            <span class="metric-value">${service.endpoint}</span>
                        </div>` : ''}
                        ${service.latency ? `
                        <div class="metric-row">
                            <span class="metric-label">Latency</span>
                            <span class="metric-value">
                                <span class="status-indicator ${service.latency < 5 ? 'status-good' : service.latency < 20 ? 'status-warning' : 'status-error'}">
                                    ${service.latency}ms
                                </span>
                            </span>
                        </div>` : ''}
                        ${service.reachable !== undefined ? `
                        <div class="metric-row">
                            <span class="metric-label">Reachable</span>
                            <span class="metric-value">
                                <span class="status-indicator ${service.reachable ? 'status-good' : 'status-error'}">
                                    ${service.reachable ? '✅ Yes' : '❌ No'}
                                </span>
                            </span>
                        </div>` : ''}
                        ${service.source ? `
                        <div class="metric-row">
                            <span class="metric-label">Source</span>
                            <span class="metric-value">${service.source}</span>
                        </div>` : ''}
                    </div>
                `).join('')}
            </div>
        </div>` : ''}

        ${data.migrationEvents?.events?.length > 0 ? `
        <div class="card" style="margin-top: 20px;">
            <h3>📝 Migration Event Log</h3>
            <div class="network-interfaces">
                ${data.migrationEvents.events.slice(0, 5).map(event => `
                    <div class="interface-item">
                        <div class="interface-name">${event.type.toUpperCase()} Event</div>
                        <div class="metric-row">
                            <span class="metric-label">Time</span>
                            <span class="metric-value" style="font-size: 0.85rem;">${new Date(event.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div class="metric-row">
                            <span class="metric-label">Message</span>
                            <span class="metric-value" style="font-size: 0.85rem;">${event.message}</span>
                        </div>
                        ${event.keyword ? `
                        <div class="metric-row">
                            <span class="metric-label">Trigger</span>
                            <span class="metric-value">
                                <span class="status-indicator status-warning">${event.keyword}</span>
                            </span>
                        </div>` : ''}
                    </div>
                `).join('')}
            </div>
        </div>` : ''}

        <div class="footer">
            <p><strong>🚀 KubeVirt Live Migration Demo</strong></p>
            <p>🔄 Auto-refresh: 3s | 📊 Tracking: ${data.kubernetesServices?.serviceEndpoints?.length || 0} services |
               🌐 DNS: ${data.network.dnsServers.length} servers |
               🏥 Health: ${data.serviceHealth?.totalServicesChecked > 0 ? Math.round((data.serviceHealth.criticalServicesUp / data.serviceHealth.totalServicesChecked) * 100) : 0}%</p>
            <p><strong>Watch these metrics change during live migration:</strong> DNS servers, API endpoints, geographic location, service IPs</p>
            ${data.migrationEvents?.migrationDetected ?
                `<p style="color: #ffc107; font-weight: bold;">⚠️ MIGRATION IN PROGRESS - ${data.migrationEvents.events?.length || 0} events detected</p>` :
                `<p style="color: #4CAF50;">✅ Ready for live migration - All systems stable</p>`}
        </div>
    </div>

    <script>
        function refreshData() {
            fetch('/api/metrics')
                .then(response => response.json())
                .then(data => {
                    location.reload();
                })
                .catch(error => {
                    console.error('Refresh failed:', error);
                });
        }

        setInterval(refreshData, 3000);

        document.addEventListener('DOMContentLoaded', function() {
            document.body.style.opacity = '0';
            document.body.style.transition = 'opacity 0.5s ease';
            setTimeout(() => {
                document.body.style.opacity = '1';
            }, 100);
        });
    </script>
</body>
</html>`;

    res.send(html);
  } catch (error) {
    console.error('Error rendering dashboard:', error);
    res.status(500).send('Internal Server Error');
  }
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 VM Migration Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 API: http://localhost:${PORT}/api/metrics`);
  console.log(`💚 Health: http://localhost:${PORT}/health`);
});