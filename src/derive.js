import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bech32 } from 'bech32';
import { serializeNativeScript } from '@meshsdk/core';

function accountKey(value, label) {
  if (typeof value !== 'string' || !value.startsWith('acct_shared_xvk1')) {
    throw new Error(`${label} 必须是 acct_shared_xvk`);
  }
  try {
    const decoded = bech32.decode(value, 200);
    const bytes = Buffer.from(bech32.fromWords(decoded.words));
    if (bytes.length !== 64) throw new Error(`长度为 ${bytes.length}，预期 64`);
    return CSL.Bip32PublicKey.from_bytes(bytes);
  } catch (error) {
    throw new Error(`${label} 无效: ${error.message}`);
  }
}

function keyHash(keys, cosigner, role, index) {
  const key = keys.get(cosigner);
  if (!key) throw new Error(`模板引用了未知的 ${cosigner}`);
  return key.derive(role).derive(index).to_raw_key().hash().to_hex();
}

export function instantiateTemplate(template, cosigners, role, index) {
  const keys = new Map(Object.entries(cosigners || {}).map(([name, value]) => [name, accountKey(value, name)]));

  function visit(node) {
    if (typeof node === 'string') return { type: 'sig', keyHash: keyHash(keys, node, role, index) };
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('script template 节点无效');
    if (node.some && Number.isInteger(node.some.at_least) && node.some.at_least >= 1
      && Array.isArray(node.some.from) && node.some.at_least <= node.some.from.length) {
      return { type: 'atLeast', required: node.some.at_least, scripts: node.some.from.map(visit) };
    }
    if (Number.isInteger(node.active_from) || Number.isInteger(node.active_until)) {
      throw new Error('当前 MVP 不支持含 active_from/active_until 的 timelock 模板');
    }
    throw new Error(`不支持的 script template 节点: ${JSON.stringify(node)}`);
  }
  return visit(template);
}

function scriptCredential(script) {
  const cbor = serializeNativeScript(script).scriptCbor;
  return CSL.Credential.from_scripthash(CSL.NativeScript.from_bytes(Buffer.from(cbor, 'hex')).hash());
}

// 唯一的地址派生规则：
//   payment：m/1854'/1815'/0'/0/index（role 0，index 从 0 递增）
//   stake：  固定 m/1854'/1815'/0'/2/0（role 2 / index 0）
// 所有地址都是 script payment + script stake 的 base address。
function addressFor(networkId, paymentScript, stakeScript) {
  return CSL.BaseAddress.new(networkId, scriptCredential(paymentScript), scriptCredential(stakeScript))
    .to_address().to_bech32();
}

function fixedStakeScript(delegation) {
  return instantiateTemplate(delegation.template, delegation.cosigners, 2, 0);
}

export function deriveStakeScript(wallet) {
  const delegation = templateEntry(
    wallet?.derivation?.delegation_script_template,
    'delegation_script_template',
  );
  return fixedStakeScript(delegation);
}

function templateEntry(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.cosigners || !value.template) {
    throw new Error(`${name} 必须包含 cosigners 和 template`);
  }
  const entries = Object.entries(value.cosigners);
  if (entries.length < 1 || entries.length > 10) throw new Error(`${name} cosigners 数量必须是 1..10`);
  const labels = entries.map(([label]) => label);
  const seenXpubs = new Set();
  for (const [label, xpub] of entries) {
    if (!label) throw new Error(`${name} cosigner 标签不能为空`);
    accountKey(xpub, `${name}.${label}`);
    if (seenXpubs.has(xpub)) throw new Error(`${name} 不允许重复的 account xpub`);
    seenXpubs.add(xpub);
  }
  const template = value.template;
  if (!template || typeof template !== 'object' || Array.isArray(template)
    || Object.keys(template).length !== 1 || !template.some
    || typeof template.some !== 'object' || Array.isArray(template.some)
    || Object.keys(template.some).some((key) => !['at_least', 'from'].includes(key))) {
    throw new Error(`${name} 必须是唯一的 m-of-n some 模板`);
  }
  const { at_least: required, from } = template.some;
  if (!Number.isInteger(required) || required < 1 || required > labels.length) {
    throw new Error(`${name} 的 m 必须介于 1 和 n 之间`);
  }
  if (!Array.isArray(from) || from.length !== labels.length || new Set(from).size !== from.length
    || from.some((label) => !labels.includes(label)) || labels.some((label) => !from.includes(label))) {
    throw new Error(`${name} 必须恰好引用每个 cosigner 一次`);
  }
  return value;
}

function unifiedTemplates(paymentValue, delegationValue) {
  const payment = templateEntry(paymentValue, 'payment_script_template');
  const delegation = templateEntry(delegationValue, 'delegation_script_template');
  const paymentSome = payment.template.some;
  const delegationSome = delegation.template.some;
  if (paymentSome.at_least !== delegationSome.at_least
    || JSON.stringify(paymentSome.from) !== JSON.stringify(delegationSome.from)
    || paymentSome.from.some((label) => payment.cosigners[label] !== delegation.cosigners[label])) {
    throw new Error('payment/delegation 必须使用完全相同顺序的 cosigners 和 m-of-n 模板');
  }
  return { payment, delegation };
}

export function deriveSharedWallet(input) {
  // 地址必须是 base address，且 payment/stake 使用同一组 m-of-n cosigners。
  const { payment, delegation } = unifiedTemplates(
    input.payment_script_template,
    input.delegation_script_template,
  );
  const gap = input.address_pool_gap ?? 20;
  if (!Number.isInteger(gap) || gap < 1 || gap > 100) throw new Error('address_pool_gap 必须是 1..100 的整数');
  const networkId = input.network === 'mainnet' ? 1 : 0;
  const stakeScript = fixedStakeScript(delegation);
  const accounts = [];
  for (let index = 0; index < gap; index += 1) {
    const paymentScript = instantiateTemplate(payment.template, payment.cosigners, 0, index);
    accounts.push({
      address: addressFor(networkId, paymentScript, stakeScript),
      payment_script: paymentScript,
      role: 'external',
      index,
    });
  }
  return {
    version: 1,
    name: input.name,
    network: input.network,
    change_address: accounts[0].address,
    accounts,
    derivation: {
      scheme: 'CIP-1854',
      address_pool_gap: gap,
      payment_script_template: payment,
      delegation_script_template: delegation,
      payment_path: "m/1854'/1815'/0'/0/index",
      delegation_path: "m/1854'/1815'/0'/2/0",
    },
  };
}

export function normalizeHdMultisigExport(input) {
  if (input.format !== 'cardano-hd-multisig') return input;
  const allowed = new Set(['format', 'version', 'name', 'network', 'threshold', 'account', 'gapLimit', 'cosigners']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`cardano-hd-multisig 包含未知字段: ${key}`);
  }
  if (input.version !== 1) throw new Error('cardano-hd-multisig version 必须是 1');
  if (!['mainnet', 'preprod'].includes(input.network)) {
    throw new Error('cardano-hd-multisig 描述文件 network 只支持 mainnet 或 preprod');
  }
  if (input.account !== 0) throw new Error('cardano-hd-multisig 描述文件 account 必须是 0');
  if (!Array.isArray(input.cosigners) || input.cosigners.length === 0 || input.cosigners.length > 10) {
    throw new Error('cardano-hd-multisig cosigners 数量必须是 1..10');
  }
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > input.cosigners.length) {
    throw new Error('threshold 必须介于 1 和 cosigner 数量之间');
  }

  const cosigners = {};
  const labels = [];
  const seenXpubs = new Set();
  input.cosigners.forEach((cosigner, index) => {
    if (!cosigner || typeof cosigner !== 'object' || Array.isArray(cosigner)) {
      throw new Error(`cosigners[${index}] 无效`);
    }
    for (const key of Object.keys(cosigner)) {
      if (!['name', 'accountXpub'].includes(key)) throw new Error(`cosigners[${index}] 包含未知字段: ${key}`);
    }
    if (typeof cosigner.name !== 'string' || !cosigner.name.trim()) {
      throw new Error(`cosigners[${index}] name 不能为空`);
    }
    if (seenXpubs.has(cosigner.accountXpub)) throw new Error('不允许重复的 accountXpub');
    seenXpubs.add(cosigner.accountXpub);
    const label = `cosigner#${index}`;
    accountKey(cosigner?.accountXpub, label); // Validate before derivation starts.
    cosigners[label] = cosigner.accountXpub;
    labels.push(label);
  });
  const template = {
    some: { at_least: input.threshold, from: labels },
  };
  const gap = input.gapLimit ?? 20;
  if (!Number.isInteger(gap) || gap < 1 || gap > 100) throw new Error('gapLimit 必须是 1..100 的整数');
  const networkId = input.network === 'mainnet' ? 1 : 0;
  const delegationScript = fixedStakeScript({ cosigners, template });
  const accounts = [];
  for (let index = 0; index < gap; index += 1) {
    const paymentScript = instantiateTemplate(template, cosigners, 0, index);
    accounts.push({
      address: addressFor(networkId, paymentScript, delegationScript),
      payment_script: paymentScript,
      role: 'external',
      index,
    });
  }
  return {
    version: 1,
    name: input.name || `Cardano ${input.network} ${input.threshold}-of-${input.cosigners.length} multisig`,
    network: input.network,
    change_address: accounts[0].address,
    accounts,
    derivation: {
      scheme: 'CIP-1854',
      address_pool_gap: gap,
      payment_script_template: { cosigners, template },
      delegation_script_template: { cosigners, template },
      payment_path: "m/1854'/1815'/0'/0/index",
      delegation_path: "m/1854'/1815'/0'/2/0",
    },
    source: {
      format: input.format,
      account: input.account,
      cosigner_names: input.cosigners.map((cosigner) => cosigner.name || null),
    },
  };
}

export function deriveReceiveAddresses(wallet, count) {
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error('地址数量必须是 1..1000 的整数');
  }
  const derivation = wallet.derivation;
  const { payment, delegation } = unifiedTemplates(
    derivation?.payment_script_template,
    derivation?.delegation_script_template,
  );
  const networkId = wallet.network === 'mainnet' ? 1 : 0;
  const stakeScript = fixedStakeScript(delegation);
  const addresses = [];
  for (let index = 0; index < count; index += 1) {
    const paymentScript = instantiateTemplate(payment.template, payment.cosigners, 0, index);
    const address = addressFor(networkId, paymentScript, stakeScript);
    const known = wallet.accounts.find((account) => account.role === 'external' && account.index === index);
    if (known && known.address !== address) {
      throw new Error(`派生安全检查失败：index ${index} 与钱包内已保存地址不一致`);
    }
    addresses.push({
      index,
      path: `m/1854'/1815'/0'/0/${index}`,
      address,
      address_type: 'base',
    });
  }
  return addresses;
}
