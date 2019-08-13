"use strict";

const execa = require("execa");
const os = require("os");
const net = require("net");

const gwArgs = "path Win32_NetworkAdapterConfiguration where IPEnabled=true get DefaultIPGateway,GatewayCostMetric,IPConnectionMetric,Index /format:table".split(" ");
const ifArgs = index => `path Win32_NetworkAdapter where Index=${index} get NetConnectionID,MACAddress /format:table`.split(" ");

const spawnOpts = {
  windowsHide: true,
};

// Parsing tables like this. The final metric is GatewayCostMetric + IPConnectionMetric
//
// DefaultIPGateway             GatewayCostMetric  Index  IPConnectionMetric
// {"1.2.3.4", "2001:db8::1"}   {0, 256}           12     25
// {"2.3.4.5"}                  {25}               12     55
function parseGwTable(gwTable, family) {
  let [bestGw, bestMetric, bestId] = [null, null, null];

  for (let line of (gwTable || "").trim().split(/\r?\n/).splice(1)) {
    line = line.trim();
    const [_, gwArr, gwCostsArr, id, ipMetric] = /({.+?}) +?({.+?}) +?([0-9]+) +?([0-9]+)/g.exec(line) || [];
    if (!gwArr) continue;

    const gateways = (gwArr.match(/"(.+?)"/g) || []).map(match => match.substring(1, match.length - 1));
    const gatewayCosts = (gwCostsArr.match(/[0-9]+/g) || []);

    for (const [index, gateway] of Object.entries(gateways)) {
      if (!gateway || `v${net.isIP(gateway)}` !== family) continue;

      const metric = parseInt(gatewayCosts[index]) + parseInt(ipMetric);
      if (!bestGw || metric < bestMetric) {
        [bestGw, bestMetric, bestId] = [gateway, metric, id];
      }
    }
  }

  if (bestGw) return [bestGw, bestId];
}

function parseIfTable(ifTable) {
  const line = (ifTable || "").trim().split("\n")[1];

  let [mac, name] = line.trim().split(/\s+/);
  mac = mac.toLowerCase();

  // try to get the interface name by matching the mac to os.networkInterfaces to avoid wmic's encoding issues
  // https://github.com/silverwind/default-gateway/issues/14
  for (const [osname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr && addr.mac && addr.mac.toLowerCase() === mac) {
        return osname;
      }
    }
  }
  return name;
}

const promise = async family => {
  const gwTable = await execa.stdout("wmic", gwArgs, spawnOpts);
  const [gateway, id] = parseGwTable(gwTable, family) || [];

  if (!gateway) {
    throw new Error("Unable to determine default gateway");
  }

  let name;
  if (id) {
    const ifTable = await execa.stdout("wmic", ifArgs(id), spawnOpts);
    name = parseIfTable(ifTable);
  }

  return {gateway, interface: name ? name : null};
};

const sync = family => {
  const gwTable = execa.sync("wmic", gwArgs, spawnOpts).stdout;
  const [gateway, id] = parseGwTable(gwTable, family) || [];

  if (!gateway) {
    throw new Error("Unable to determine default gateway");
  }

  let name;
  if (id) {
    const ifTable = execa.sync("wmic", ifArgs(id), spawnOpts).stdout;
    name = parseIfTable(ifTable);
  }

  return {gateway, interface: name ? name : null};
};

module.exports.v4 = () => promise("v4");
module.exports.v6 = () => promise("v6");

module.exports.v4.sync = () => sync("v4");
module.exports.v6.sync = () => sync("v6");
