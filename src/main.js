import { invoke } from "@tauri-apps/api/tauri";
import { open, confirm } from "@tauri-apps/api/dialog";
import { readTextFile } from "@tauri-apps/api/fs";
import { basename, join, resolveResource } from "@tauri-apps/api/path";
import { appWindow } from "@tauri-apps/api/window";

document.addEventListener('DOMContentLoaded', () => {
    let gamePath = null, currentFilePath = null, xmlDoc = null, isPopulating = false;
    let currentTranslations = {};
    
    // --- Manual Drag and Drop State Variables ---
    let draggedElement = null;
    let ghostElement = null;
    let placeholder = null;
    let offsetX = 0;
    let offsetY = 0;
    let originalNextSibling = null;


    const mainContent = document.querySelector('.main-content');
    // --- Make the Window Wider based on Language ---
    const updateWindowSize = (forceResize = false) => {
        if (!forceResize) {
            return;
        }

        requestAnimationFrame(() => {
            const originalWidth = mainContent.style.width;
            mainContent.style.width = 'max-content';
            const requiredWidth = mainContent.scrollWidth;
            mainContent.style.width = originalWidth;
            const finalWidth = Math.max(750, requiredWidth + 10);
            invoke('resize_window', { width: finalWidth }).catch(console.error);
        });
    };
    // --- Language Stuff ---
    const i18n = {
        async loadLanguage(lang) {
            try {
                const resourcePath = await resolveResource(`locales/${lang}.json`);
                const content = await readTextFile(resourcePath);
                currentTranslations = JSON.parse(content);
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
                const attributeName = el.getAttribute('data-i18n-attr');
                if (currentTranslations[key]) {
                    const translatedText = currentTranslations[key];
                    if (attributeName) {
                        el.setAttribute(attributeName, translatedText);
                    } else {
                        el.textContent = translatedText;
                    }
                }
            });
            if (currentFilePath) {
                basename(currentFilePath).then(fileNameWithExt => {
                    const fileNameWithoutExt = fileNameWithExt.slice(0, fileNameWithExt.lastIndexOf('.'));
                    filePathLabel.textContent = this.get('editingFile', { fileName: fileNameWithoutExt });
                });
            } else {
                filePathLabel.textContent = this.get('noFileLoaded');
            }
            updateWindowSize();
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
          searchModsInput = document.getElementById('searchModsInput'),
          languageSelector = document.getElementById('languageSelector'),
          enableAllBtn = document.getElementById('enableAllBtn'),
          disableAllBatchBtn = document.getElementById('disableAllBatchBtn');
    
    document.getElementById('minimizeBtn').addEventListener('click', () => appWindow.minimize());
    document.getElementById('maximizeBtn').addEventListener('click', () => appWindow.toggleMaximize());
    document.getElementById('closeBtn').addEventListener('click', () => appWindow.close());

    // --- DELETE MOD ---: Context Menu Logic
    let contextMenu = null;

    const removeContextMenu = () => {
        if (contextMenu) {
            contextMenu.remove();
            contextMenu = null;
        }
    };

    // Hide context menu if clicking anywhere else on the window or its frame
    window.addEventListener('click', removeContextMenu, true); 
    window.addEventListener('contextmenu', (e) => {
        // Prevent default unless the user is right-clicking on an input field
        const target = e.target;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
            e.preventDefault();
        }
        removeContextMenu(); // Always remove an old menu when a new one is requested
    }, true);

    modListContainer.addEventListener('contextmenu', (e) => {
        const modRow = e.target.closest('.mod-row');
        if (!modRow) return;

        e.preventDefault();
        e.stopPropagation(); // Stop the event from bubbling to the window listener
        removeContextMenu(); // Ensure any previous menu is gone

        const modName = modRow.dataset.modName;

        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';
        contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
        contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 85)}px`;

        const copyButton = document.createElement('button');
        copyButton.textContent = i18n.get('copyModNameBtn'); 
        copyButton.className = 'context-menu-item';

        copyButton.onclick = async () => {
            removeContextMenu();
            try {
                await navigator.clipboard.writeText(modName);
                alert(i18n.get('copySuccess', { modName })); // Confirmation message
            } catch (err) {
                console.error('Failed to copy text: ', err);
                alert('Could not copy text to clipboard.');
            }
        };

        const deleteButton = document.createElement('button');
        deleteButton.textContent = i18n.get('deleteModBtn', { modName });
        deleteButton.className = 'context-menu-item delete';

        deleteButton.onclick = async () => {
            removeContextMenu();
            const confirmed = await confirm(
                i18n.get('confirmDeleteMod', { modName }),
                { title: i18n.get('confirmDeleteTitle'), type: 'warning' }
            );

            if (confirmed) {
                try {
                    // 1. Rust modifies data and returns the new XML string
                    const updatedXmlContent = await invoke('delete_mod', { modName: modName });
                    // 2. We load this new XML into our browser's DOM
                    await loadXmlContent(updatedXmlContent, currentFilePath);
                    // 3. CRITICAL: We now tell our JavaScript serializer to save the file
                    await saveChanges(); 
                    
                    alert(i18n.get('deleteSuccess', { modName }));
                } catch (error) {
                    alert(`${i18n.get('deleteError', { modName })}\n\n${error}`);
                }
            }
        };

        contextMenu.appendChild(copyButton); 
        contextMenu.appendChild(deleteButton);
        document.body.appendChild(contextMenu);
    });
    // --- DELETE MOD END ---

    // --- MANUAL DRAG AND DROP LOGIC ---
    function onMouseMove(e) {
        if (!ghostElement || !placeholder) return;
        ghostElement.style.left = `${e.clientX - offsetX}px`;
        ghostElement.style.top = `${e.clientY - offsetY}px`;
        const allRows = Array.from(modListContainer.querySelectorAll('.mod-row:not(.is-dragging)'));
        let nextElement = null;
        for (const row of allRows) {
            const rect = row.getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                nextElement = row;
                break;
            }
        }
        if (nextElement) {
            modListContainer.insertBefore(placeholder, nextElement);
        } else {
            modListContainer.appendChild(placeholder);
        }
    }

    function onMouseUp(e) {
        if (!draggedElement || !ghostElement || !placeholder) {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            return;
        }
        const dropTarget = e.target.closest('#modListContainer');
        if (dropTarget) {
            placeholder.parentNode.insertBefore(draggedElement, placeholder);
            const finalModOrder = Array.from(modListContainer.querySelectorAll('.mod-row')).map(row => row.dataset.modName);
            reorderModsByList(finalModOrder);
        } else {
            modListContainer.insertBefore(draggedElement, originalNextSibling);
            renderModList(); 
        }
        draggedElement.classList.remove('is-dragging');
        document.body.removeChild(ghostElement);
        if (placeholder.parentNode) {
            placeholder.parentNode.removeChild(placeholder);
        }
        draggedElement = null;
        ghostElement = null;
        placeholder = null;
        originalNextSibling = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }

    modListContainer.addEventListener('mousedown', (e) => {
        if (e.target.closest('.switch')) {
            return;
        }
        const row = e.target.closest('.mod-row');
        if (!row || e.button !== 0) return;
        e.preventDefault();
        draggedElement = row;
        originalNextSibling = draggedElement.nextSibling;
        const rect = draggedElement.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        placeholder = document.createElement('div');
        placeholder.className = 'placeholder';
        placeholder.style.height = `${rect.height}px`;
        ghostElement = draggedElement.cloneNode(true);
        ghostElement.classList.add('ghost');
        document.body.appendChild(ghostElement);
        ghostElement.style.width = `${rect.width}px`;
        ghostElement.style.left = `${e.clientX - offsetX}px`;
        ghostElement.style.top = `${e.clientY - offsetY}px`;
        draggedElement.parentNode.insertBefore(placeholder, draggedElement);
        draggedElement.classList.add('is-dragging');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    const filterModList = () => {
        const searchTerm = searchModsInput.value.trim().toLowerCase();
        const modRows = modListContainer.querySelectorAll('.mod-row');
        modRows.forEach(row => {
            const modNameElement = row.querySelector('.mod-name');
            if (modNameElement) {
                const modName = modNameElement.textContent.toLowerCase();
                if (modName.includes(searchTerm)) {
                    row.style.display = 'flex';
                } else {
                    row.style.display = 'none';
                }
            }
        });
    };
    searchModsInput.addEventListener('input', filterModList);

    const initializeApp = async () => {
        const savedLang = localStorage.getItem('selectedLanguage') || 'en';
        languageSelector.value = savedLang;
        await i18n.loadLanguage(savedLang);
        gamePath = await invoke('get_game_path');
        const hasGamePath = !!gamePath;
        openModsFolderBtn.disabled = !hasGamePath;
        troubleshootBtn.disabled = !hasGamePath;
        enableAllBtn.classList.toggle('disabled', !hasGamePath);
        disableAllBatchBtn.classList.toggle('disabled', !hasGamePath);
        dropZone.classList.toggle('hidden', !hasGamePath);
        if (!hasGamePath) {
            const title = "Could not find NMS installation path";
            openModsFolderBtn.title = title;
            troubleshootBtn.title = title;
            enableAllBtn.title = title;
            disableAllBatchBtn.title = title;
            return;
        }
        enableAllBtn.title = '';
        disableAllBatchBtn.title = '';
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
        const fileNameWithExt = await basename(currentFilePath);
        const fileNameWithoutExt = fileNameWithExt.slice(0, fileNameWithExt.lastIndexOf('.'));
        filePathLabel.textContent = i18n.get('editingFile', { fileName: fileNameWithoutExt });
        xmlDoc = new DOMParser().parseFromString(content, "application/xml");
        renderModList();
    };

    const renderModList = () => {
        if (!xmlDoc) return;
        isPopulating = true;
        modListContainer.innerHTML = '';
        const disableAllNode = xmlDoc.querySelector('Property[name="DisableAllMods"]');
        if (disableAllNode) {
            disableAllSwitch.checked = disableAllNode.getAttribute('value').toLowerCase() === 'true';
            disableAllSwitch.disabled = false;
        }
        const modNodes = xmlDoc.querySelectorAll('Property[name="Data"] > Property[value="GcModSettingsInfo"]');
        const modsToRender = Array.from(modNodes).map(modNode => {
            const priority = parseInt(modNode.querySelector('Property[name="ModPriority"]')?.getAttribute('value') || '0', 10);
            return { modNode, priority };
        }).sort((a, b) => a.priority - b.priority);
        modsToRender.forEach(({ modNode }) => {
            const name = unescapeXml(modNode.querySelector('Property[name="Name"]')?.getAttribute('value') || 'Unknown Mod');
            const priority = modNode.querySelector('Property[name="ModPriority"]')?.getAttribute('value') || '0';
            const enabled = modNode.querySelector('Property[name="Enabled"]')?.getAttribute('value').toLowerCase() === 'true';
            const row = document.createElement('div');
            row.className = 'mod-row';
            row.dataset.modName = name;
            row.innerHTML = `
                <span class="mod-name">${name}</span>
                <div class="priority"><input type="text" class="priority-input" value="${priority}" readonly></div>
                <div class="enabled"><label class="switch"><input type="checkbox" class="enabled-switch" ${enabled ? 'checked' : ''}><span class="slider"></span></label></div>
            `;
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
        filterModList();
    };

    const reorderModsByList = (orderedModNames) => {
        const allModNodes = Array.from(xmlDoc.querySelectorAll('Property[name="Data"] > Property[value="GcModSettingsInfo"]'));
        orderedModNames.forEach((modName, newPriority) => {
            const modNode = allModNodes.find(node => unescapeXml(node.querySelector('Property[name="Name"]').getAttribute('value')) === modName);
            if (modNode) {
                const priorityNode = modNode.querySelector('Property[name="ModPriority"]');
                if (priorityNode) {
                    priorityNode.setAttribute('value', newPriority.toString());
                }
            }
        });
        saveChanges();
        renderModList();
    };

    const saveChanges = async () => {
        if (isPopulating || !currentFilePath || !xmlDoc) return;
        const formattedXmlString = formatNode(xmlDoc.documentElement, 0);
        const finalContent = `<?xml version="1.0" encoding="utf-8"?>\n${formattedXmlString.trimEnd()}`;
        try { 
            await invoke('save_file', { filePath: currentFilePath, content: finalContent });
        }
        catch (e) { alert(`Error saving file: ${e}`); }
    };

    /* Sets the enabled state for all individual mods. */
    const setAllModsEnabled = (enabled) => {
        if (!xmlDoc) {
            alert("Please load a GCMODSETTINGS file first.");
            return;
        }

        const modNodes = xmlDoc.querySelectorAll('Property[name="Data"] > Property[value="GcModSettingsInfo"]');
        if (modNodes.length === 0) return;

        const newValue = enabled ? 'true' : 'false';

        modNodes.forEach(modNode => {
            const enabledNode = modNode.querySelector('Property[name="Enabled"]');
            const enabledVRNode = modNode.querySelector('Property[name="EnabledVR"]');
            if (enabledNode) {
                enabledNode.setAttribute('value', newValue);
            }
            if (enabledVRNode) {
                enabledVRNode.setAttribute('value', newValue);
            }
        });

        saveChanges();
        renderModList();
    };

    enableAllBtn.addEventListener('click', () => setAllModsEnabled(true));
    disableAllBatchBtn.addEventListener('click', () => setAllModsEnabled(false));

    const addNewModToXml = (modName) => {
        if (!xmlDoc || !modName) return;
        const dataContainer = xmlDoc.querySelector('Property[name="Data"]');
        if (!dataContainer) { return; }
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

    const escapeXml = (unsafe) => {
        return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    };
    const unescapeXml = (safe) => {
        return safe.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
    };
    const formatNode = (node, indentLevel) => {
        const indent = '  '.repeat(indentLevel);
        
        let attributeList = Array.from(node.attributes);
        const nameAttr = node.getAttribute('name');

        // Special rule 1: The main <Property name="Data"> container
        const isMainDataContainer = (
            nameAttr === 'Data' &&
            node.parentNode &&
            node.parentNode.tagName === 'Data'
        );
        // Special rule 2: The <Property name="Dependencies" /> tag
        const isDependenciesTag = (nameAttr === 'Dependencies');

        // If either special rule applies, strip the 'value' attribute
        if (isMainDataContainer || isDependenciesTag) {
            attributeList = attributeList.filter(attr => attr.name !== 'value');
        }

        const attributes = attributeList.map(attr => `${attr.name}="${escapeXml(attr.value)}"`).join(' ');
        const tag = node.tagName;
        let nodeString = `${indent}<${tag}${attributes ? ' ' + attributes : ''}`;

        if (node.children.length > 0) {
            nodeString += '>\n';
            for (const child of node.children) {
                nodeString += formatNode(child, indentLevel + 1);
            }
            nodeString += `${indent}</${tag}>\n`;
        } else {
            // This correctly adds the space before the self-closing tag
            nodeString += ' />\n'; 
        }
        return nodeString;
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
            if (draggedElement) {
                return;
            }
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
                    const fileName = await basename(filePath);
                    try {
                        const analysis = await invoke('install_mod_from_archive', { archivePathStr: filePath });

                        // Case 1: Handle "messy" archives that need a name from the user.
                        if (analysis.messy_archive_path) {
                            let finalModName = prompt(`Successfully extracted files from ${fileName}, but no valid mod folder was found.\n\nPlease enter a name for this mod (or leave blank to cancel):`);
                            if (finalModName && finalModName.trim().length > 0) {
                                finalModName = finalModName.trim();
                                await invoke('finalize_mod_installation', {
                                    tempPath: analysis.messy_archive_path,
                                    newName: finalModName
                                });
                                addNewModToXml(finalModName);
                                alert(i18n.get('alertExtractSuccess', { fileName }));
                            } else {
                                await invoke('cleanup_temp_folder', { path: analysis.messy_archive_path });
                                alert(`Installation from ${fileName} was cancelled.`);
                            }
                        }

                        // Case 2: Process mods that were installed successfully without conflict.
                        if (analysis.successes && analysis.successes.length > 0) {
                            const installedNames = analysis.successes.map(mod => mod.name);
                            for (const mod of analysis.successes) {
                                addNewModToXml(mod.name);
                            }
                            alert(`Successfully installed ${installedNames.length} new mod(s) from ${fileName}:\n\n- ${installedNames.join('\n- ')}`);
                        }

                        // Case 3: Process mods that conflict with existing ones.
                        if (analysis.conflicts && analysis.conflicts.length > 0) {
                            for (const conflict of analysis.conflicts) {
                                const shouldReplace = await confirm(
                                    `A mod named "${conflict.name}" is already installed. Do you want to replace it with the new version from ${fileName}?`,
                                    { title: 'Mod Conflict', type: 'warning' }
                                );

                                await invoke('resolve_conflict', {
                                    modName: conflict.name,
                                    tempModPathStr: conflict.temp_path,
                                    replace: shouldReplace
                                });

                                if (shouldReplace) {
                                    alert(`Mod "${conflict.name}" was successfully updated.`);
                                } else {
                                    alert(`Update for mod "${conflict.name}" was cancelled.`);
                                }
                            }
                        }

                    } catch (error) {
                        alert(i18n.get('alertExtractError', { fileName, error }));
                    }
                }
            } else {
                dropZone.classList.remove('drag-over');
            }
        });
    };
    
    languageSelector.addEventListener('change', async (e) => {
    await i18n.loadLanguage(e.target.value);
    updateWindowSize(true);
    });
    
    initializeApp();
    setupDragAndDrop();
});