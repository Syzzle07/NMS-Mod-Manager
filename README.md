# NMS Mod Manager

A modern, lightweight mod manager for No Man's Sky built with Tauri, Rust, and web technologies.

![Screenshot of NMS Mod Manager](path/to/your/screenshot.png)

## Features

*   **Automatic Game Detection:** Finds your Steam or GOG installation of No Man's Sky automatically.
*   **Mod Management:** Easily enable, disable, and set the priority of your mods.
*   **Drag & Drop Installation:** Install mods by simply dropping `.zip` or `.rar` files onto the application.
*   **Troubleshooting:** Includes tools to safely reset your mod settings file.

## How to Build

This project requires Rust and the Tauri prerequisites to be installed.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Syzzle07/NMS-Mod-Manager.git
    cd NMS-Mod-Manager
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Run in development mode:**
    ```bash
    npm run tauri dev
    ```
4.  **Build the final application:**
    ```bash
    npm run tauri build
    ```