import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { readTextFile } from "@tauri-apps/api/fs";
import { basename, join } from "@tauri-apps/api/path";
import { appWindow } from "@tauri-apps/api/window";

document.addEventListener('DOMContentLoaded', () => {
    let gamePath = null, currentFilePath = null, xmlDoc = null, isPopulating = false;

    // Element references
    const loadFileBtn = document.getElementById('loadFileBtn'),
          openModsFolderBtn = document.getElementById('openModsFolderBtn'),
          filePathLabel = document.getElementById('filePathLabel'),
          disableAllSwitch = document.getElementById('disableAllSwitch'),
          modListContainer = document.getElementById('modListContainer'),
          troubleshootBtn = document.getElementById('troubleshootBtn'),
          modalOverlay = document.getElementById('modalOverlay'),
          cancelModalBtn = document.getElementById('cancelModalBtn'),
          deleteSettingsBtn = document.getElementById('deleteSettingsBtn'),
          dropZone = document.getElementById('dropZone');
    
    // Title Bar Events
    document.getElementById('minimizeBtn').addEventListener('click', () => appWindow.minimize());
    document.getElementById('maximizeBtn').addEventListener('click', () => appWindow.toggleMaximize());
    document.getElementById('closeBtn').addEventListener('click', () => appWindow.close());

    // --- Function to reset the entire UI to its initial state ---
    const resetUiToFileLoadedState = (message) => {
        filePathLabel.textContent = message;
        disableAllSwitch.checked = false;
        disableAllSwitch.disabled = true;
        modListContainer.innerHTML = ''; 
    };
    
    // Initialization & Auto-Loading
    const initializeApp = async () => {
        gamePath = await invoke('get_game_path');
        const hasGamePath = !!gamePath;
        openModsFolderBtn.disabled = !hasGamePath;
        troubleshootBtn.disabled = !hasGamePath;
        dropZone.classList.toggle('hidden', !hasGamePath);

        if (!hasGamePath) {
            const title = "Could not find NMS installation path";
            openModsFolderBtn.title = title;
            troubleshootBtn.title = title;
            return;
        }

        try {
            const settingsPath = await join(gamePath, 'Binaries', 'SETTINGS', 'GCMODSETTINGS.MXML');
            const content = await readTextFile(settingsPath);
            await loadXmlContent(content, settingsPath);
        } catch (e) {
            console.warn("Could not auto-load settings file.", e);
            filePathLabel.textContent = "No file loaded. Game detected.";
        }
    };

    const loadXmlContent = async (content, path) => {
        currentFilePath = path;
        filePathLabel.textContent = `Editing: ${await basename(currentFilePath)}`;
        xmlDoc = new DOMParser().parseFromString(content, "application/xml");
        renderModList();
    };

    const renderModList = () => {
        isPopulating = true;
        modListContainer.innerHTML = '';
        const disableAllNode = xmlDoc.querySelector('Property[name="DisableAllMods"]');
        if (disableAllNode) {
            disableAllSwitch.checked = disableAllNode.getAttribute('value').toLowerCase() === 'true';
            disableAllSwitch.disabled = false;
        }
        const modNodes = xmlDoc.querySelectorAll('Property[name="Data"] > Property[value="GcModSettingsInfo"]');
        modNodes.forEach(modNode => {
            const name = modNode.querySelector('Property[name="Name"]')?.getAttribute('value') || 'Unknown',
                  priority = modNode.querySelector('Property[name="ModPriority"]')?.getAttribute('value') || '0',
                  enabled = modNode.querySelector('Property[name="Enabled"]')?.getAttribute('value').toLowerCase() === 'true';
            const row = document.createElement('div');
            row.className = 'mod-row';
            row.innerHTML = `<span class="mod-name">${name}</span><div class="priority"><input type="text" class="priority-input" value="${priority}"></div><div class="enabled"><label class="switch"><input type="checkbox" class="enabled-switch" ${enabled ? 'checked' : ''}><span class="slider"></span></label></div>`;
            row.querySelector('.priority-input').addEventListener('input', (e) => {
                const pNode = modNode.querySelector('Property[name="ModPriority"]');
                if (pNode) { pNode.setAttribute('value', e.target.value); saveChanges(); }
            });
            row.querySelector('.enabled-switch').addEventListener('change', (e) => {
                const newVal = e.target.checked ? 'true' : 'false';
                const eNode = modNode.querySelector('Property[name="Enabled"]');
                const evrNode = modNode.querySelector('Property[name="EnabledVR"]');
                if (eNode) eNode.setAttribute('value', newVal);
                if (evrNode) evrNode.setAttribute('value', newVal);
                saveChanges();
            });
            modListContainer.appendChild(row);
        });
        isPopulating = false;
    };
    
    const saveChanges = async () => {
        if (isPopulating || !currentFilePath || !xmlDoc) return;
        const xmlString = '<?xml version="1.0" encoding="utf-8"?>\n' + new XMLSerializer().serializeToString(xmlDoc.documentElement);
        try { await invoke('save_file', { filePath: currentFilePath, content: xmlString }); }
        catch (e) { alert(`Error saving file: ${e}`); }
    };

    loadFileBtn.addEventListener('click', async () => {
        let startDir = gamePath ? `${gamePath}\\Binaries\\SETTINGS` : undefined;
        const selPath = await open({ title: 'Select GCMODSETTINGS File', defaultPath: startDir, filters: [{ name: 'MXML Files', extensions: ['mxml'] }] });
        if (typeof selPath === 'string') {
            const content = await readTextFile(selPath);
            await loadXmlContent(content, selPath);
        }
    });

    openModsFolderBtn.addEventListener('click', () => invoke('open_mods_folder'));
    disableAllSwitch.addEventListener('change', () => {
        const daNode = xmlDoc.querySelector('Property[name="DisableAllMods"]');
        if (daNode) { daNode.setAttribute('value', disableAllSwitch.checked ? 'true' : 'false'); saveChanges(); }
    });
    
    const showModal = () => modalOverlay.classList.remove('hidden');
    const hideModal = () => modalOverlay.classList.add('hidden');
    troubleshootBtn.addEventListener('click', showModal);
    cancelModalBtn.addEventListener('click', hideModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) hideModal(); });

    // Delete button now resets the application state ---
    deleteSettingsBtn.addEventListener('click', async () => {
        try {
            const message = await invoke('delete_settings_file');
            
            currentFilePath = null;
            xmlDoc = null;

            resetUiToFileLoadedState("No file loaded. Settings file was deleted.");

            alert(message);
        } catch (error) {
            alert(`Error: ${error}`);
        } finally {
            hideModal();
        }
    });

    const setupDragAndDrop = async () => {
        await appWindow.onFileDropEvent(async (event) => {
            if (event.payload.type === 'hover') {
                dropZone.classList.add('drag-over');
            } else if (event.payload.type === 'drop') {
                dropZone.classList.remove('drag-over');
                const archiveFiles = event.payload.paths.filter(path => 
                    path.toLowerCase().endsWith('.zip') || path.toLowerCase().endsWith('.rar')
                );
                if (archiveFiles.length === 0) {
                    alert("No .zip or .rar files were dropped.");
                    return;
                }
                for (const filePath of archiveFiles) {
                    try {
                        const message = await invoke('install_mod_from_archive', { archivePathStr: filePath });
                        alert(message);
                    } catch (error) {
                        alert(`Error installing ${await basename(filePath)}: ${error}`);
                    }
                }
            } else {
                dropZone.classList.remove('drag-over');
            }
        });
    };
    
    document.body.addEventListener('dragover', e => e.preventDefault());
    document.body.addEventListener('drop', e => e.preventDefault());

    initializeApp();
    setupDragAndDrop();
});