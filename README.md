# Studio Recall

Studio Recall is a local Node.js web app for measuring and saving audio hardware
recall data. It can run EQ transfer-curve tests and compressor tests through a
multi-channel audio interface, then save the readings as JSON sessions.

The app is intended to run locally with the audio interface connected to the
computer. It does not send audio through the browser; the Node.js server handles
the audio input and output.

## Platform support

The audio layer uses PortAudio through `naudiodon2`, so it is designed to work
on macOS, Windows, and Linux. macOS is the original development environment;
Windows should work, but the native audio dependency must compile successfully
on the target PC and the audio interface driver must expose both input and
output channels.

## Requirements

- macOS, Windows, or Linux with an audio interface that exposes the required
  input and output channels
- Node.js LTS and npm
- A physical audio loopback or hardware path from the interface output through
  the equipment under test and back into the interface input
- Operating-system permission for the terminal or application used to run Node

## Install

From the project directory:

```bash
npm install
```

`naudiodon2` includes the PortAudio dependency used by this project. If npm
cannot build the native module on macOS, install Apple's command-line developer
tools and try again:

```bash
xcode-select --install
npm install
```

On Windows, install the **Desktop development with C++** workload from
[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
if `npm install` reports that `node-gyp` or a C++ compiler is missing. Then run
`npm install` again from PowerShell.

## Run

Start the local server:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in a browser. The server
only listens on `127.0.0.1`, so it is available on the local computer and is
not exposed to the network.

To use another port:

```bash
PORT=8080 npm start
```

In PowerShell, use:

```powershell
$env:PORT=8080; npm start
```

Stop the server with `Ctrl-C`.

## Using the app

1. Connect the audio interface and the equipment being tested.
2. Start the server and open the local web page.
3. Select an audio device and the input/output channels for a test.
4. Add an **EQ Test** or **Compression Test**.
5. Press **Start**, then **Capture reading**.
6. Add notes and save the session in the app.

Saved sessions are JSON files in [`sessions/`](./sessions). The example
sessions included in this repository can be used to confirm that the UI loads
correctly, but new measurements should be made with the correct interface and
channel routing selected.

## Audio routing notes

- The selected interface must support both the requested input and output
  channels.
- The output should be routed through the device under test and returned to the
  selected input.
- Avoid monitoring the output directly into the input unless that is the
  intended test path.
- Use conservative levels when connecting unfamiliar hardware.
- If no devices appear, check the operating system's privacy/security settings
  and allow the terminal or Node application to access audio. On macOS, this is
  **System Settings > Privacy & Security > Microphone**. On Windows, check
  **Settings > Privacy & security > Microphone** and verify that the interface
  driver is installed.

## Project structure

```text
server.js       Local HTTP server and session API
audio.js        PortAudio device handling and EQ measurement
comp.js         Compressor test signal generation and analysis
public/         Browser UI
sessions/       Saved test sessions
package.json    npm scripts and dependencies
```

## License

This project is released under the MIT license.
