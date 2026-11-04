import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { UserSession } from '../../auth/session.js';
import { refreshServerAccessGrants, broadcastServersList } from '../../network/webrtc.js';

const PROJECT = 'cookiemovie-27669';
const DB = '(default)';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}`;
const API_KEY = 'AIzaSyAxkQA5tBqp_5fco6Y_8i2mhI15ECJeNh0';

export const PERMISSION_KEYS = [
  { key: 'canStart', label: 'Start Server' },
  { key: 'canStop', label: 'Stop Server' },
  { key: 'canRestart', label: 'Restart Server' },
  { key: 'canForceKill', label: 'Force Kill Server' },
  { key: 'canViewConsole', label: 'View Console Logs' },
  { key: 'canSendConsole', label: 'Send Console Commands' },
  { key: 'canViewPlayers', label: 'View Players' },
  { key: 'canManagePlayers', label: 'Manage Players (Kick/Ban/OP)' },
  { key: 'canViewFiles', label: 'View Files' },
  { key: 'canEditFiles', label: 'Edit / Upload / Delete Files' },
  { key: 'canPluginsMods', label: 'Manage Plugins & Mods' },
  { key: 'canProperties', label: 'Edit Server Properties & Startup' },
  { key: 'canDiagnostics', label: 'View Diagnostics & Crash Reports' },
  { key: 'canWorlds', label: 'Manage Worlds & Live Map' },
  { key: 'canBackups', label: 'Create & Restore Backups' },
  { key: 'canNetworking', label: 'Manage Tunnels, DNS & Status Page' },
  { key: 'canSchedule', label: 'Manage Scheduled Tasks' },
  { key: 'canShareAccess', label: 'Manage Shared Access' },
] as const;

interface ShareGrantDoc {
  id: string;
  ownerUid: string;
  ownerUsername: string;
  recipientUid: string;
  recipientUsername: string;
  serverName: string;
  ownerNodeId: string;
  permissions: Record<string, boolean>;
  createdAt?: string;
}

interface VerifiedUser {
  uid: string;
  username: string;
  displayName?: string;
  email?: string;
}

interface Props {
  serverName: string;
  session: UserSession;
  onBack: () => void;
}

const Indicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
);

const Item: React.FC<{ isSelected?: boolean; label: string }> = ({ isSelected, label }) => (
  <Text color={isSelected ? 'cyan' : 'white'}>{label}</Text>
);

function parseFirestoreMap(fields: Record<string, any> | undefined): Record<string, any> {
  if (!fields) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.booleanValue !== undefined) out[k] = Boolean(v.booleanValue);
    else if (v.integerValue !== undefined) out[k] = Number(v.integerValue);
    else if (v.mapValue?.fields) out[k] = parseFirestoreMap(v.mapValue.fields);
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
  }
  return out;
}

function makeDefaultPermissions(defaultVal = false): Record<string, boolean> {
  const perms: Record<string, boolean> = {};
  for (const p of PERMISSION_KEYS) {
    perms[p.key] = defaultVal;
  }
  return perms;
}

export const ShareAccessScreen: React.FC<Props> = ({ serverName, session, onBack }) => {
  const [step, setStep] = useState<'list' | 'enter_uid' | 'edit_perms'>('list');
  const [grants, setGrants] = useState<ShareGrantDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [uidInput, setUidInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [targetUser, setTargetUser] = useState<VerifiedUser | null>(null);
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean>>(() => makeDefaultPermissions(false));

  const fetchGrants = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${FIRESTORE_BASE}/documents:runQuery?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'server_access' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'ownerUid' },
                op: 'EQUAL',
                value: { stringValue: session.uid },
              },
            },
          },
        }),
      });
      if (res.ok) {
        const rows = (await res.json()) as any[];
        const list: ShareGrantDoc[] = [];
        for (const r of rows) {
          if (!r?.document) continue;
          const docId = String(r.document.name || '').split('/').pop() || '';
          const d = parseFirestoreMap(r.document.fields);
          if (d.serverName === serverName) {
            list.push({
              id: docId,
              ownerUid: String(d.ownerUid || session.uid),
              ownerUsername: String(d.ownerUsername || session.displayName || session.email || 'Owner'),
              recipientUid: String(d.recipientUid || ''),
              recipientUsername: String(d.recipientUsername || d.recipientUid || 'Unknown'),
              serverName: String(d.serverName),
              ownerNodeId: String(d.ownerNodeId || session.daemonId),
              permissions: typeof d.permissions === 'object' && d.permissions ? d.permissions : {},
              createdAt: d.createdAt ? String(d.createdAt) : undefined,
            });
          }
        }
        setGrants(list);
      }
    } catch (e: any) {
      setErrorMsg(e?.message || 'Failed to load shares');
    } finally {
      setLoading(false);
    }
  }, [serverName, session.uid, session.displayName, session.email, session.daemonId]);

  useEffect(() => {
    void fetchGrants();
  }, [fetchGrants]);

  useInput((_input, key) => {
    if (key.escape) {
      if (step === 'enter_uid' || step === 'edit_perms') {
        setStep('list');
        setErrorMsg(null);
      } else {
        onBack();
      }
    }
  });

  const handleVerifyUid = async (rawInput: string) => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;
    if (trimmed === session.uid) {
      setErrorMsg('You cannot share a server with your own UID.');
      return;
    }
    setVerifying(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      // 1. Direct lookup on users/{uid}
      const directRes = await fetch(`${FIRESTORE_BASE}/documents/users/${encodeURIComponent(trimmed)}?key=${API_KEY}`);
      if (directRes.ok) {
        const docJson = (await directRes.json()) as any;
        const data = parseFirestoreMap(docJson.fields);
        const found: VerifiedUser = {
          uid: trimmed,
          username: String(data.username || data.displayName || data.email || trimmed),
          displayName: data.displayName ? String(data.displayName) : undefined,
          email: data.email ? String(data.email) : undefined,
        };
        openPermsForUser(found);
        return;
      }

      // 2. Fallback: query by username if user typed a username instead of UID
      const queryRes = await fetch(`${FIRESTORE_BASE}/documents:runQuery?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'users' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'username' },
                op: 'EQUAL',
                value: { stringValue: trimmed.toLowerCase() },
              },
            },
            limit: 1,
          },
        }),
      });
      if (queryRes.ok) {
        const rows = (await queryRes.json()) as any[];
        const docObj = rows.find(r => r?.document)?.document;
        if (docObj) {
          const foundUid = String(docObj.name || '').split('/').pop() || trimmed;
          const data = parseFirestoreMap(docObj.fields);
          const found: VerifiedUser = {
            uid: foundUid,
            username: String(data.username || data.displayName || data.email || foundUid),
            displayName: data.displayName ? String(data.displayName) : undefined,
            email: data.email ? String(data.email) : undefined,
          };
          openPermsForUser(found);
          return;
        }
      }

      setErrorMsg(`No user found in Firestore with UID "${trimmed}".`);
    } catch (e: any) {
      setErrorMsg(`Verification failed: ${e?.message || String(e)}`);
    } finally {
      setVerifying(false);
    }
  };

  const openPermsForUser = (user: VerifiedUser) => {
    const existing = grants.find(g => g.recipientUid === user.uid);
    setTargetUser(user);
    if (existing) {
      setEditingGrantId(existing.id);
      const merged = makeDefaultPermissions(false);
      for (const p of PERMISSION_KEYS) {
        if (existing.permissions[p.key] !== undefined) {
          merged[p.key] = Boolean(existing.permissions[p.key]);
        }
      }
      setPerms(merged);
    } else {
      setEditingGrantId(null);
      setPerms(makeDefaultPermissions(true));
    }
    setStep('edit_perms');
  };

  const saveGrant = async () => {
    if (!targetUser) return;
    setErrorMsg(null);
    try {
      const permFields: Record<string, any> = {};
      for (const [k, v] of Object.entries(perms)) {
        permFields[k] = { booleanValue: Boolean(v) };
      }
      // Include legacy composite flags for older clients
      permFields.canStopRestart = { booleanValue: Boolean(perms.canStop || perms.canRestart || perms.canForceKill) };
      permFields.canConsole = { booleanValue: Boolean(perms.canViewConsole || perms.canSendConsole) };
      permFields.canPlayers = { booleanValue: Boolean(perms.canViewPlayers || perms.canManagePlayers) };
      permFields.canFiles = { booleanValue: Boolean(perms.canViewFiles || perms.canEditFiles) };

      const docId = editingGrantId || `${session.uid}_${targetUser.uid}_${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const docPath = `projects/${PROJECT}/databases/${DB}/documents/server_access/${docId}`;

      await fetch(`${FIRESTORE_BASE}/documents:commit?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: docPath,
                fields: {
                  ownerUid: { stringValue: session.uid },
                  ownerUsername: { stringValue: session.displayName || session.email || 'Owner' },
                  recipientUid: { stringValue: targetUser.uid },
                  recipientUsername: { stringValue: targetUser.username },
                  serverName: { stringValue: serverName },
                  ownerNodeId: { stringValue: session.daemonId },
                  permissions: { mapValue: { fields: permFields } },
                  createdAt: { timestampValue: new Date().toISOString() },
                },
              },
            },
          ],
        }),
      });

      await refreshServerAccessGrants();
      await broadcastServersList();
      await fetchGrants();
      setStatusMsg(`Saved access permissions for ${targetUser.username} (${targetUser.uid})`);
      setStep('list');
    } catch (e: any) {
      setErrorMsg(`Failed to save grant: ${e?.message || String(e)}`);
    }
  };

  const revokeGrant = async (grantId: string, label: string) => {
    setErrorMsg(null);
    try {
      await fetch(`${FIRESTORE_BASE}/documents/server_access/${encodeURIComponent(grantId)}?key=${API_KEY}`, {
        method: 'DELETE',
      });
      await refreshServerAccessGrants();
      await broadcastServersList();
      await fetchGrants();
      setStatusMsg(`Revoked access for ${label}`);
      setStep('list');
    } catch (e: any) {
      setErrorMsg(`Failed to revoke grant: ${e?.message || String(e)}`);
    }
  };

  return (
    <Box flexDirection="column" paddingX={2} gap={1}>
      <Box flexDirection="column">
        <Text bold color="cyan">
          🤝 Share Server Access — {serverName}
        </Text>
        <Text color="gray">
          Grant friends access to manage this server using their Account UID.
        </Text>
      </Box>

      {errorMsg && <Text color="red">✖ {errorMsg}</Text>}
      {statusMsg && <Text color="green">✔ {statusMsg}</Text>}

      {step === 'list' && (
        <Box flexDirection="column" gap={1}>
          {loading ? (
            <Text color="gray">Loading shared access grants...</Text>
          ) : grants.length === 0 ? (
            <Text color="gray">No friends currently have shared access to "{serverName}".</Text>
          ) : (
            <Box flexDirection="column">
              <Text color="white" bold>
                Active Shares ({grants.length}):
              </Text>
              {grants.map(g => {
                const enabledCount = PERMISSION_KEYS.filter(pk => g.permissions[pk.key]).length;
                return (
                  <Text key={g.id} color="gray">
                    {'  '}• <Text color="white" bold>{g.recipientUsername}</Text> ({g.recipientUid}) —{' '}
                    <Text color="cyan">{enabledCount}/{PERMISSION_KEYS.length} permissions</Text>
                  </Text>
                );
              })}
            </Box>
          )}

          <SelectInput
            items={[
              { label: '  ➕ Add / Check Friend by UID', value: 'add_uid' },
              ...grants.map(g => ({
                label: `  ⚙  Edit / Revoke: ${g.recipientUsername} (${g.recipientUid})`,
                value: `edit:${g.id}`,
              })),
              { label: '  ↻  Refresh Shares', value: 'refresh' },
              { label: '  ←  Back to Server Actions', value: 'back' },
            ]}
            onSelect={item => {
              setErrorMsg(null);
              setStatusMsg(null);
              if (item.value === 'add_uid') {
                setUidInput('');
                setStep('enter_uid');
              } else if (item.value === 'refresh') {
                void fetchGrants();
              } else if (item.value === 'back') {
                onBack();
              } else if (item.value.startsWith('edit:')) {
                const gId = item.value.slice('edit:'.length);
                const g = grants.find(x => x.id === gId);
                if (g) {
                  openPermsForUser({
                    uid: g.recipientUid,
                    username: g.recipientUsername,
                  });
                }
              }
            }}
            indicatorComponent={Indicator}
            itemComponent={Item}
          />
        </Box>
      )}

      {step === 'enter_uid' && (
        <Box flexDirection="column" gap={1}>
          <Text color="white">Enter Friend's User UID (or username) to verify in Firestore:</Text>
          <Box borderStyle="single" borderColor="cyan" paddingX={1} gap={1}>
            <Text color="cyan" bold>UID ❯</Text>
            <TextInput
              value={uidInput}
              onChange={setUidInput}
              onSubmit={val => void handleVerifyUid(val)}
              placeholder="Paste friend's UID and press Enter..."
            />
          </Box>
          {verifying && <Text color="yellow">Checking users/{uidInput.trim()} in Firestore...</Text>}
          <Text color="gray">Press Enter to verify user, or Esc to cancel.</Text>
        </Box>
      )}

      {step === 'edit_perms' && targetUser && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1}>
            <Text color="green" bold>
              ✔ Verified User: {targetUser.username}
            </Text>
            <Text color="gray">
              UID: {targetUser.uid}
              {targetUser.displayName ? ` │ Name: ${targetUser.displayName}` : ''}
              {targetUser.email ? ` │ Email: ${targetUser.email}` : ''}
            </Text>
          </Box>

          <Text color="gray">
            Select a permission below and press Enter to toggle it, then choose Save Grant:
          </Text>

          <SelectInput
            limit={12}
            items={[
              { label: '  💾 Save & Apply Permissions', value: '__save__' },
              { label: '  ☑  Enable All 18 Permissions', value: '__all_on__' },
              { label: '  ☐  Disable All 18 Permissions', value: '__all_off__' },
              ...(editingGrantId
                ? [{ label: '  ✕  Revoke Friend Access', value: '__revoke__' }]
                : []),
              ...PERMISSION_KEYS.map(pk => ({
                label: `  [${perms[pk.key] ? '✔' : ' '}] ${pk.label} (${pk.key})`,
                value: `toggle:${pk.key}`,
              })),
              { label: '  ←  Cancel', value: '__cancel__' },
            ]}
            onSelect={item => {
              if (item.value === '__save__') {
                void saveGrant();
              } else if (item.value === '__all_on__') {
                setPerms(makeDefaultPermissions(true));
              } else if (item.value === '__all_off__') {
                setPerms(makeDefaultPermissions(false));
              } else if (item.value === '__revoke__' && editingGrantId) {
                void revokeGrant(editingGrantId, targetUser.username);
              } else if (item.value === '__cancel__') {
                setStep('list');
              } else if (item.value.startsWith('toggle:')) {
                const k = item.value.slice('toggle:'.length);
                setPerms(prev => ({ ...prev, [k]: !prev[k] }));
              }
            }}
            indicatorComponent={Indicator}
            itemComponent={Item}
          />
        </Box>
      )}
    </Box>
  );
};
