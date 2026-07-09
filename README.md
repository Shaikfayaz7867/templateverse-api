# TemplateVerse Local Backend

A fully functional Express & Node.js backend for the TemplateVerse Android client app.

## Prerequisites
- [Node.js](https://nodejs.org) (v18 or higher recommended)
- Android Emulator or USB debugging enabled physical device

## Setup and Installation

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install the package dependencies:
   ```bash
   npm install
   ```

3. Run the development server (automatically restarts on file changes):
   ```bash
   npm run dev
   ```

The server will start listening on port `3000`.

## Client Connection Details
- **Android Emulator**: The app is pre-configured to point to `http://10.0.2.2:3000/v1/`, which is the special IP address mapping the host computer's localhost interface inside the Android Emulator sandbox.
- **Physical Device**: Update the `LOCAL_BASE_URL` constant inside `AppContainer.kt` in the Android project code to use your host machine's local IP address (e.g. `http://192.168.1.15:3000/v1/`), and ensure both your computer and mobile device are connected to the same Wi-Fi network.
