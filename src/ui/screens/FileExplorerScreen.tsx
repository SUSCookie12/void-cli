import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { 
  listEntries, 
  readTextFile, 
  writeTextFile, 
  deleteEntry, 
  createEntry, 
  renameEntry,
  type FileEntry 
} from '../../utils/fileExplorer.js';

interface Props {
  serverName: string;
  onBack: () => void;
}

type Mode = 'browse' | 'edit' | 'confirm_delete' | 'input_name' | 'confirm_discard';

export const FileExplorerScreen: React.FC<Props> = ({ serverName, onBack }) => {
  const [path, setPath] = useState<string>('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [mode, setMode] = useState<Mode>('browse');
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  
  // Editor state
  const [editContent, setEditContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  
  // Input state
  const [inputText, setInputText] = useState('');
  const [inputAction, setInputAction] = useState<'new_file' | 'new_folder' | 'rename' | null>(null);

  const refresh = useCallback(() => {
    try {
      setEntries(listEntries(serverName, path));
    } catch (err) {
      // If error (e.g. folder deleted), go up one level
      if (path !== '') {
        setPath(prev => prev.split('/').slice(0, -1).join('/'));
      }
    }
  }, [serverName, path]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useInput((input, key) => {
    if (mode === 'browse') {
      if (key.escape || key.backspace) {
        if (path !== '') {
          setPath(prev => prev.split('/').slice(0, -1).join('/'));
        } else if (key.escape) {
          onBack();
        }
      }
      if (input === 'n') {
        setInputAction('new_folder');
        setInputText('');
        setMode('input_name');
      }
      if (input === 'N') {
        setInputAction('new_file');
        setInputText('');
        setMode('input_name');
      }
    } else if (mode === 'edit') {
      if (key.escape) {
        if (isDirty) {
          setMode('confirm_discard');
        } else {
          setMode('browse');
        }
      }
      // Ctrl+S to save
      if (input === '\u0013') { // Ctrl+S
        if (selectedEntry && selectedEntry.type === 'file') {
          writeTextFile(serverName, `${path}/${selectedEntry.name}`.replace(/^\//,''), editContent);
          setIsDirty(false);
        }
      }
    }
  });

  const handleSelect = (item: { value: string }) => {
    const entry = entries.find(e => e.name === item.value);
    if (!entry) return;

    if (entry.type === 'folder') {
      setPath(prev => (prev === '' ? entry.name : `${prev}/${entry.name}`));
    } else {
      if (entry.isEditable) {
        try {
          const content = readTextFile(serverName, `${path}/${entry.name}`.replace(/^\//,''));
          setEditContent(content);
          setSelectedEntry(entry);
          setIsDirty(false);
          setMode('edit');
        } catch (err) {
          // Handle error (e.g. binary file reported as editable)
        }
      }
    }
  };

  const handleInputSubmit = (val: string) => {
    if (!val.trim()) {
      setMode('browse');
      return;
    }

    try {
      const fullPath = `${path}/${val}`.replace(/^\//,'');
      if (inputAction === 'new_folder') {
        createEntry(serverName, fullPath, true);
      } else if (inputAction === 'new_file') {
        createEntry(serverName, fullPath, false);
      } else if (inputAction === 'rename' && selectedEntry) {
        const oldPath = `${path}/${selectedEntry.name}`.replace(/^\//,'');
        renameEntry(serverName, oldPath, fullPath);
      }
      refresh();
    } catch (err) {
      // Handle error
    }
    setMode('browse');
  };

  if (mode === 'edit') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Box marginBottom={1} gap={2}>
          <Text color="cyan" bold>EDITING: {selectedEntry?.name}</Text>
          <Text color="gray">│</Text>
          <Text color={isDirty ? 'yellow' : 'green'}>{isDirty ? '● Unsaved' : '✔ Saved'}</Text>
          <Text color="gray">│</Text>
          <Text color="white">Ctrl+S: Save  Esc: Exit</Text>
        </Box>
        <Box borderStyle="single" borderColor="gray" paddingX={1} minHeight={15}>
          <TextInput 
            value={editContent} 
            onChange={(val) => {
              setEditContent(val);
              setIsDirty(true);
            }} 
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'confirm_discard') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="single" borderColor="yellow">
        <Text bold color="yellow"> ⚠  Unsaved Changes</Text>
        <Text color="white" marginTop={1}>You have unsaved changes in "{selectedEntry?.name}". What would you like to do?</Text>
        <Box marginTop={1}>
          <SelectInput 
            items={[
              { label: '  ✔ Save and Exit', value: 'save' },
              { label: '  ✖ Discard Changes', value: 'discard' },
              { label: '  ← Cancel', value: 'cancel' }
            ]}
            onSelect={(item) => {
              if (item.value === 'save') {
                writeTextFile(serverName, `${path}/${selectedEntry?.name}`.replace(/^\//,''), editContent);
                setIsDirty(false);
                setMode('browse');
              } else if (item.value === 'discard') {
                setIsDirty(false);
                setMode('browse');
              } else {
                setMode('edit');
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'input_name') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="single" borderColor="cyan">
        <Text bold color="white">
          {inputAction === 'new_folder' ? 'New Folder Name:' : 
           inputAction === 'new_file' ? 'New File Name:' : 'Rename To:'}
        </Text>
        <Box marginTop={1}>
          <Text color="cyan">❯ </Text>
          <TextInput value={inputText} onChange={setInputText} onSubmit={handleInputSubmit} />
        </Box>
        <Text color="gray" marginTop={1}>Press Enter to confirm, Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1} gap={1}>
        <Text color="yellow" bold>📂 {serverName}</Text>
        <Text color="gray">/</Text>
        <Text color="white">{path || '(root)'}</Text>
      </Box>

      <Box borderStyle="single" borderColor="cyan" flexDirection="column" minHeight={10}>
        <SelectInput 
          items={entries.map(e => ({
            label: `${e.type === 'folder' ? '📁' : '📄'} ${e.name.padEnd(30)} ${e.type === 'file' ? (e.size / 1024).toFixed(1) + ' KB' : ''}`,
            value: e.name
          }))}
          onSelect={handleSelect}
        />
        {entries.length === 0 && (
          <Box paddingX={2}>
            <Text color="gray" italic>Directory is empty</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} gap={2} paddingX={1}>
        <Text color="gray">↑↓ Navigate</Text>
        <Text color="gray">Enter Open</Text>
        <Text color="gray">Backspace Up</Text>
        <Text color="cyan">n New Folder</Text>
        <Text color="cyan">Shift+N New File</Text>
        <Text color="gray">Esc Back</Text>
      </Box>
    </Box>
  );
};
