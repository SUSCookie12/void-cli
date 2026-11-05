import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { getVanillaReleases } from '../../api/mojang.js';
import { getPaperVersions } from '../../api/paper.js';
import { getPurpurVersions } from '../../api/purpur.js';
import { getFabricGameVersions } from '../../api/fabric.js';
import { getForgeGameVersions } from '../../api/forge.js';
import { getNeoForgeGameVersions } from '../../api/neoforge.js';
import { getQuiltGameVersions } from '../../api/quilt.js';
import { installServer, type InstallProgress } from '../../server/installer.js';
import {
  isValidServerName,
  serverExists,
  getNextAvailablePort,
  type ServerMeta,
} from '../../server/manager.js';

type ServerType = 'vanilla' | 'paper' | 'fabric' | 'forge' | 'purpur' | 'neoforge' | 'quilt';
type Step = 'type' | 'version' | 'name' | 'port' | 'ram' | 'confirm' | 'installing' | 'done' | 'error';

const STEPS: Step[] = ['type', 'version', 'name', 'port', 'ram', 'confirm', 'installing', 'done'];

const RAM_OPTIONS = [
  { label: '512 MB  (Minimal — testing only)', value: '512M' },
  { label: '1 GB    (Very small server)', value: '1G' },
  { label: '2 GB    (Recommended — small server)', value: '2G' },
  { label: '4 GB    (Medium server)', value: '4G' },
  { label: '6 GB    (Large server)', value: '6G' },
  { label: '8 GB    (Very large server)', value: '8G' },
];

interface Props {
  onDone: () => void;
  onBack: () => void;
}

const displayName = (type: string): string => {
  const names: Record<string, string> = {
    paper: 'Paper MC',
    vanilla: 'Vanilla',
    fabric: 'Fabric',
    forge: 'Forge',
    purpur: 'Purpur',
    neoforge: 'NeoForge',
    quilt: 'Quilt',
  };
  return names[type] || type;
};

const Indicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
);
const Item: React.FC<{ isSelected?: boolean; label: string }> = ({ isSelected, label }) => (
  <Text color={isSelected ? 'cyan' : 'white'}>{label}</Text>
);

export const CreateServerScreen: React.FC<Props> = ({ onDone, onBack }) => {
  const [step, setStep] = useState<Step>('type');
  const [serverType, setServerType] = useState<ServerType>('paper');
  const [versions, setVersions] = useState<string[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [serverName, setServerName] = useState('');
  const [nameError, setNameError] = useState('');
  const [selectedRam, setSelectedRam] = useState('2G');
  
  const [portInput, setPortInput] = useState(() => String(getNextAvailablePort()));
  const [portError, setPortError] = useState('');
  const [port, setPort] = useState(() => getNextAvailablePort());

  const [progress, setProgress] = useState<InstallProgress>({ stage: 'creating', progress: 0, message: '' });
  const [error, setError] = useState('');

  useInput((_input, key) => {
    if (!key.escape) return;
    const idx = STEPS.indexOf(step);
    if (step === 'type') onBack();
    else if (idx > 0 && step !== 'installing' && step !== 'done' && step !== 'error') {
      setStep(STEPS[idx - 1]);
    }
  });

  const loadVersions = async (type: ServerType) => {
    setLoadingVersions(true);
    setVersions([]);
    try {
      if (type === 'vanilla') {
        const releases = await getVanillaReleases();
        setVersions(releases.slice(0, 25).map(v => v.id));
      } else if (type === 'paper' || type === 'purpur') {
        const v = type === 'purpur' ? await getPurpurVersions() : await getPaperVersions();
        setVersions(v.slice(0, 25));
      } else if (type === 'fabric') {
        const v = await getFabricGameVersions(25);
        setVersions(v);
      } else if (type === 'forge') {
        const v = await getForgeGameVersions(25);
        setVersions(v);
      } else if (type === 'neoforge') {
        const v = await getNeoForgeGameVersions(25);
        setVersions(v);
      } else if (type === 'quilt') {
        const v = await getQuiltGameVersions(25);
        setVersions(v);
      }
    } catch (err) {
      setError(`Failed to load versions: ${err instanceof Error ? err.message : String(err)}`);
      setStep('error');
    } finally {
      setLoadingVersions(false);
    }
  };

  const handleNameSubmit = (name: string) => {
    if (!isValidServerName(name)) {
      setNameError('Only letters, numbers, - and _ allowed (max 32 chars)');
      return;
    }
    if (serverExists(name)) {
      setNameError(`A server named "${name}" already exists`);
      return;
    }
    setNameError('');
    setServerName(name);
    setStep('port');
  };

  const handlePortSubmit = (portStr: string) => {
    const p = parseInt(portStr, 10);
    if (isNaN(p) || p < 1024 || p > 65535) {
      setPortError('Port must be a number between 1024 and 65535');
      return;
    }
    // Very basic check if another meta uses it? 
    // Usually getNextAvailablePort checks our managed servers.
    // For now, accept valid number:
    setPortError('');
    setPort(p);
    setStep('ram');
  };

  const handleInstall = async () => {
    setStep('installing');
    const cleanVersion = selectedVersion;
    const meta: ServerMeta = {
      name: serverName,
      type: serverType,
      version: cleanVersion,
      ram: selectedRam,
      port,
      createdAt: new Date().toISOString(),
    };
    try {
      await installServer(meta, setProgress);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  // Step breadcrumb
  const currentIdx = STEPS.indexOf(step);
  const breadcrumb = (
    <Box gap={0}>
      {STEPS.slice(0, -1).map((s, i) => (
        <Text
          key={s}
          color={i === currentIdx ? 'cyan' : i < currentIdx ? 'green' : 'gray'}
          bold={i === currentIdx}
        >
          {i > 0 ? ' › ' : ''}{s.charAt(0).toUpperCase() + s.slice(1)}
        </Text>
      ))}
    </Box>
  );

  const barFill = Math.floor(progress.progress / 5);
  const progressBar = (
    <Box>
      <Text color="cyan">{'█'.repeat(barFill)}</Text>
      <Text color="gray">{'░'.repeat(20 - barFill)}</Text>
      <Text color="white">  {progress.progress}%</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header row */}
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={0} marginBottom={1} gap={1}>
        <Text bold color="cyan">CREATE SERVER</Text>
        <Text color="gray">│</Text>
        {breadcrumb}
      </Box>

      {/* ── STEP: TYPE ── */}
      {step === 'type' && (
        <Box flexDirection="column" gap={1}>
          <Text color="white" bold> Select server type:</Text>
          <SelectInput
            items={[
              { label: '  Paper MC   (Recommended — better performance, plugin support)', value: 'paper' },
              { label: '  Vanilla    (Official Mojang server — no plugins)', value: 'vanilla' },
              { label: '  Fabric     (Mod loader — add Fabric mods in /mods)', value: 'fabric' },
              { label: '  Forge      (Mod loader — add Forge mods in /mods)', value: 'forge' },
              { label: '  Purpur     (Paper fork — enhanced features, plugin support)', value: 'purpur' },
              { label: '  NeoForge   (Next-gen Forge — mod loader)', value: 'neoforge' },
              { label: '  Quilt      (Fabric fork — modern mod loader)', value: 'quilt' },
            ]}
            onSelect={item => {
              setServerType(item.value as ServerType);
              setStep('version');
              loadVersions(item.value as ServerType);
            }}
            indicatorComponent={Indicator}
            itemComponent={Item}
          />
          <Text color="gray" dimColor> Esc to go back</Text>
        </Box>
      )}

      {/* ── STEP: VERSION ── */}
      {step === 'version' && (
        <Box flexDirection="column" gap={1}>
          <Text color="white" bold> Select {serverType} version:</Text>
          {loadingVersions ? (
            <Box gap={1}><Text color="cyan"><Spinner type="dots" /></Text><Text color="gray"> Fetching versions...</Text></Box>
          ) : (
            <>
              <SelectInput
                items={versions.map(v => ({ label: `  ${v}`, value: v }))}
                onSelect={item => { setSelectedVersion(item.value); setStep('name'); }}
                limit={12}
                indicatorComponent={Indicator}
                itemComponent={Item}
              />
              <Text color="gray" dimColor> Showing latest 25 releases  │  Esc to go back</Text>
            </>
          )}
        </Box>
      )}

      {/* ── STEP: NAME ── */}
      {step === 'name' && (
        <Box flexDirection="column" gap={1}>
          <Text color="white" bold> Server name:</Text>
          <Text color="gray"> Letters, numbers, hyphens and underscores only (max 32)</Text>
          <Box gap={1} paddingX={1}>
            <Text color="cyan">❯</Text>
            <TextInput
              value={serverName}
              onChange={setServerName}
              onSubmit={handleNameSubmit}
              placeholder="my-survival-server"
            />
          </Box>
          {nameError ? <Text color="red"> ✗ {nameError}</Text> : null}
          <Text color="gray" dimColor> Enter to continue  │  Esc to go back</Text>
        </Box>
      )}

      {/* ── STEP: PORT ── */}
      {step === 'port' && (
        <Box flexDirection="column" gap={1}>
          <Text color="white" bold> Server port:</Text>
          <Text color="gray"> Port number to bind to (default is available: {port})</Text>
          <Box gap={1} paddingX={1}>
            <Text color="cyan">❯</Text>
            <TextInput
              value={portInput}
              onChange={setPortInput}
              onSubmit={handlePortSubmit}
              placeholder={String(port)}
            />
          </Box>
          {portError ? <Text color="red"> ✗ {portError}</Text> : null}
          <Text color="gray" dimColor> Enter to continue  │  Esc to go back</Text>
        </Box>
      )}

      {/* ── STEP: RAM ── */}
      {step === 'ram' && (
        <Box flexDirection="column" gap={1}>
          <Text color="white" bold> Allocate RAM:</Text>
          <SelectInput
            items={RAM_OPTIONS.map(r => ({ label: `  ${r.label}`, value: r.value }))}
            initialIndex={2}
            onSelect={item => { setSelectedRam(item.value); setStep('confirm'); }}
            indicatorComponent={Indicator}
            itemComponent={Item}
          />
          <Text color="gray" dimColor> Esc to go back</Text>
        </Box>
      )}

      {/* ── STEP: CONFIRM ── */}
      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text color="white" bold> Confirm server details:</Text>
          <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={2} paddingY={1}>
            <Box><Text color="gray">  Name:    </Text><Text color="cyan" bold>{serverName}</Text></Box>
            <Box>
              <Text color="gray">  Type:    </Text>
              <Text color="white">
                {displayName(serverType)}
              </Text>
            </Box>
            <Box><Text color="gray">  Version: </Text><Text color="white">{selectedVersion}</Text></Box>
            <Box><Text color="gray">  RAM:     </Text><Text color="white">{selectedRam}</Text></Box>
            <Box><Text color="gray">  Port:    </Text><Text color="white">:{port}</Text></Box>
          </Box>
          <SelectInput
            items={[
              { label: '  ✓ Install Server', value: 'install' },
              { label: '  ← Go Back', value: 'back' },
            ]}
            onSelect={item => {
              if (item.value === 'install') handleInstall();
              else setStep('ram');
            }}
            indicatorComponent={Indicator}
            itemComponent={Item}
          />
        </Box>
      )}

      {/* ── STEP: INSTALLING ── */}
      {step === 'installing' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text color="white"> Installing <Text bold color="cyan">{serverName}</Text>...</Text>
          </Box>
          <Text color="gray"> {progress.message}</Text>
          {progressBar}
        </Box>
      )}

      {/* ── STEP: DONE ── */}
      {step === 'done' && (
        <Box flexDirection="column" gap={1}>
          <Text color="green" bold> ✓ Server "{serverName}" created successfully!</Text>
          <Text color="gray"> Start it from the main menu.</Text>
          <SelectInput
            items={[{ label: '  ← Back to Main Menu', value: 'done' }]}
            onSelect={onDone}
            indicatorComponent={Indicator}
            itemComponent={Item}
          />
        </Box>
      )}

      {/* ── STEP: ERROR ── */}
      {step === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color="red" bold> ✗ Installation failed</Text>
          <Text color="gray"> {error}</Text>
          <SelectInput
            items={[
              { label: '  ↺ Try Again', value: 'retry' },
              { label: '  ← Back to Main Menu', value: 'back' },
            ]}
            onSelect={item => {
              if (item.value === 'retry') { setStep('type'); setError(''); }
              else onBack();
            }}
            indicatorComponent={Indicator}
            itemComponent={Item}
          />
        </Box>
      )}
    </Box>
  );
};
