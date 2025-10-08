import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { readTextFile } from "@tauri-apps/api/fs";
import { basename, join } from "@tauri-apps/api/path";
import { appWindow } from "@tauri-apps/api/window";

document.addEventListener('DOMContentLoaded', () => {
    let gamePath = null, currentFilePath = null, xmlDoc = null, isPopulating = false;
    let currentTranslations = {};

    const i18n = {
        async loadLanguage(lang) {
            try {
                const response = await fetch(`/src/locales/${lang}.json`);
                currentTranslations = await response.json();
                localStorage.setItem('selectedLanguage', lang);
                this.updateUI();
            } catch (e) {
                console.error(`Failed to load language file for ${lang}`, e);
                if (lang !== 'en') await this.loadLanguage('en');
            }
        },
        updateUI() {
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (currentTranslations[key]) {
                    el.textContent = currentTranslations[key];
                }
            });
            if (currentFilePath) {
                basename(currentFilePath).then(fileName => {
                    filePathLabel.textContent = this.get('editingFile', { fileName });
                });
            } else {
                filePathLabel.textContent = this.get('noFileLoaded');
            }
        },
        get(key, placeholders = {}) {
            let text = currentTranslations[key] || key;
            for (const [placeholder, value] of Object.entries(placeholders)) {
                text = text.replace(`{{${placeholder}}}`, value);
            }
            return text;
        }
    };

    const loadFileBtn = document.getElementById('loadFileBtn'),
          openModsFolderBtn = document.getElementById('openModsFolderBtn'),
          filePathLabel = document.getElementById('filePathLabel'),
          disableAllSwitch = document.getElementById('disableAllSwitch'),
          modListContainer = document.getElementById('modListContainer'),
          troubleshootBtn = document.getElementById('troubleshootBtn'),
          modalOverlay = document.getElementById('modalOverlay'),
          cancelModalBtn = document.getElementById('cancelModalBtn'),
          deleteSettingsBtn = document.getElementById('deleteSettingsBtn'),
          dropZone = document.getElementById('dropZone'),
          languageSelector = document.getElementById('languageSelector');
    
    document.getElementById('minimizeBtn').addEventListener('click', () => appWindow.minimize());
    document.getElementById('maximizeBtn').addEventListener('click', () => appWindow.toggleMaximize());
    document.getElementById('closeBtn').addEventListener('click', () => appWindow.close());

    window.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    const initializeApp = async () => {
        const savedLang = localStorage.getItem('selectedLanguage') || 'en';
        languageSelector.value = savedLang;
        await i18n.loadLanguage(savedLang);
        
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
            console.warn("Could not auto-load settings file. It may not exist yet.", e);
            if (filePathLabel.textContent === i18n.get('noFileLoaded')) {
                filePathLabel.textContent += " Game detected.";
            }
        }
    };

    const loadXmlContent = async (content, path) => {
        currentFilePath = path;
        const fileName = await basename(currentFilePath);
        filePathLabel.textContent = i18n.get('editingFile', { fileName });
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
            const name = modNode.querySelector('Property[name="Name"]')?.getAttribute('value') || 'Unknown Mod',
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
    
    // --- NEW: XML Pretty Print Function ---
    const formatXml = (xmlString) => {
        let formatted = '', indent= '';
        const tab = '  '; // Use 2 spaces for indentation
        xmlString.split(/>\s*</).forEach(node => {
            if (node.match( /^\/\w/ )) indent = indent.substring(tab.length); // decrease indent by one 'tab'
            formatted += indent + '<' + node + '>\r\n';
            if (node.match( /^<?\w[^>]*[^\/]$/ )) indent += tab; // increase indent
        });
        return formatted.substring(1, formatted.length-3);
    };
    
    const saveChanges = async () => {
        if (isPopulating || !currentFilePath || !xmlDoc) return;
        
        // Serialize the document to a string
        const serializer = new XMLSerializer();
        const xmlString = serializer.serializeToString(xmlDoc.documentElement);
        
        // Format the string for pretty printing
        const formattedXmlString = `<?xml version="1.0" encoding="utf-8"?>\n<Data>${formatXml(xmlString)}</Data>`;

        try { 
            await invoke('save_file', { filePath: currentFilePath, content: formattedXmlString });
        }
        catch (e) { alert(`Error saving file: ${e}`); }
    };

    const addNewModToXml = (modName) => {
        if (!xmlDoc || !modName) return;
        const dataContainer = xmlDoc.querySelector('Property[name="Data"]');
        if (!dataContainer) {
            console.error("Could not find the main 'Data' container in the XML.");
            return;
        }
        const allMods = dataContainer.querySelectorAll('Property[value="GcModSettingsInfo"]');
        let maxIndex = -1;
        let maxPriority = -1;
        allMods.forEach(mod => {
            const index = parseInt(mod.getAttribute('_index'), 10);
            const priorityNode = mod.querySelector('Property[name="ModPriority"]');
            const priority = priorityNode ? parseInt(priorityNode.getAttribute('value'), 10) : -1;
            if (index > maxIndex) maxIndex = index;
            if (priority > maxPriority) maxPriority = priority;
        });
        const newMod = xmlDoc.createElement('Property');
        newMod.setAttribute('name', 'Data');
        newMod.setAttribute('value', 'GcModSettingsInfo');
        newMod.setAttribute('_index', (maxIndex + 1).toString());
        const createProp = (name, value) => {
            const prop = xmlDoc.createElement('Property');
            prop.setAttribute('name', name);
            prop.setAttribute('value', value);
            return prop;
        };
        newMod.appendChild(createProp('Name', modName.toUpperCase()));
        newMod.appendChild(createProp('Author', ''));
        newMod.appendChild(createProp('ID', '0'));
        newMod.appendChild(createProp('AuthorID', '0'));
        newMod.appendChild(createProp('LastUpdated', '0'));
        newMod.appendChild(createProp('ModPriority', (maxPriority + 1).toString()));
        newMod.appendChild(createProp('Enabled', 'true'));
        newMod.appendChild(createProp('EnabledVR', 'true'));
        const dependencies = xmlDoc.createElement('Property');
        dependencies.setAttribute('name', 'Dependencies');
        newMod.appendChild(dependencies);
        dataContainer.appendChild(newMod);
        renderModList();
        saveChanges();
    };

    loadFileBtn.addEventListener('click', async () => {
        let startDir = gamePath ? `${gamePath}\\Binaries\\SETTINGS` : undefined;
        const selPath = await open({ title: i18n.get('loadFileBtn'), defaultPath: startDir, filters: [{ name: 'MXML Files', extensions: ['mxml'] }] });
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
    deleteSettingsBtn.addEventListener('click', async () => {
        try {
            const resultKey = await invoke('delete_settings_file');
            currentFilePath = null;
            xmlDoc = null;
            filePathLabel.textContent = i18n.get('noFileLoaded') + " " + i18n.get('settingsDeleted');
            disableAllSwitch.checked = false;
            disableAllSwitch.disabled = true;
            modListContainer.innerHTML = '';
            alert(i18n.get(resultKey));
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
                if (!xmlDoc) {
                    alert("Please load a GCMODSETTINGS.MXML file before installing new mods.");
                    return;
                }
                const archiveFiles = event.payload.paths.filter(p => p.toLowerCase().endsWith('.zip') || p.toLowerCase().endsWith('.rar'));
                if (archiveFiles.length === 0) {
                    alert(i18n.get('alertNoZipsDropped'));
                    return;
                }
                for (const filePath of archiveFiles) {
                    try {
                        const modName = await invoke('install_mod_from_archive', { archivePathStr: filePath });
                        if (modName && modName.length > 0) {
                            addNewModToXml(modName);
                            alert(i18n.get('alertExtractSuccess', { fileName: await basename(filePath) }));
                        } else {
                             alert(`Successfully extracted ${await basename(filePath)}, but could not determine a mod name to add to the list.`);
                        }
                    } catch (error) {
                        const fileName = await basename(filePath);
                        alert(i18n.get('alertExtractError', { fileName, error }));
                    }
                }
            } else {
                dropZone.classList.remove('drag-over');
            }
        });
    };
    
    languageSelector.addEventListener('change', (e) => {
        i18n.loadLanguage(e.target.value);
    });
    
    document.body.addEventListener('dragover', e => e.preventDefault());
    document.body.addEventListener('drop', e => e.preventDefault());

    initializeApp();
    setupDragAndDrop();
});