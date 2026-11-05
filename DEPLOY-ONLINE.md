# Put Ludo Rewired online (Render)

This project has both the browser and the multiplayer game server. **Use a Node.js Web Service, not a static hosting service.** The server needs WebSockets to keep up to eight players in sync.

## Easy method: Render Blueprint (recommended)

1. Extract this ZIP, and open the extracted **ludo-rewired-online** folder.
2. Create a free GitHub account at https://github.com/ (if needed), then create a **new empty repository**, e.g. `ludo-rewired-online`.
3. Upload **the contents** of the extracted folder to the repository (the repository root must contain `server.js`, `package.json` and `render.yaml`, not a ZIP file or an extra nested folder). On GitHub choose **Add file → Upload files**, drag the extracted files and folders into the upload area, and click **Commit changes**. If your browser doesn't support folder upload, follow the Git commands below.
4. Visit https://dashboard.render.com/ and connect your GitHub account.
5. Choose **New → Blueprint**, select the repository you created, and use the included `render.yaml`. Approve the web service deployment. The configuration requests Render's Free compute plan and its Singapore region.
6. After deployment completes and the service shows **Live**, open the actual URL displayed in your Render dashboard (normally an `https://...onrender.com` address).
7. Enter your player name, click **Create room**, and choose **Copy invite link** in the lobby. Send that link to friends. They can join from phones or laptops, anywhere, using the same link or code.
8. To verify deployment, open `https://YOUR-ACTUAL-RENDER-URL/health` in a browser. It should return JSON containing `"ok":true`.

### Alternative: regular Web Service

In Render select **New → Web Service**, connect the GitHub repository and set:

- Runtime: **Node**
- Instance type: **Free**, if available for your account
- Build command: `npm install --omit=dev`
- Start command: `npm start`
- Health check: `/health`
- Root directory: blank (project files are at repository root)

### Upload via Git (when dragging folders into GitHub doesn't work)

Create an empty repository on GitHub first and copy its HTTPS URL. Then run these commands from inside the extracted folder using Git Bash, Terminal, or the VS Code terminal:

```sh
git init
git add .
git commit -m "Deploy Ludo Rewired online"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

Replace `YOUR-USERNAME` and `YOUR-REPO` with your real repository details. GitHub might ask you to authenticate before pushing.

## Important limitations

- On Render's Free tier, the server **can sleep after 15 minutes without inbound activity** and may take around a minute to wake. Connected browsers send a lightweight heartbeat during an open session. A server restart or redeploy still erases all ongoing rooms, because this game deliberately has no database.
- Use **one instance**. Room state is stored in the memory of that server, not shared across multiple instances. No persistence of game state is provided.
- Invite codes identify an active room only on **your specific Render URL**. There is no global room directory and no public lobby.
- This is suitable for a group of friends playing together, not production-grade matchmaking or high-traffic deployment.
- Render account connection and deployment must be completed by the account owner. This ZIP is **deployment-ready**, not automatically deployed.

## Test before uploading

Requires Node.js 20+:

```sh
npm test
npm start
```

Open http://localhost:3000 and create a room. The browser automatically uses `wss://` when visiting the deployed HTTPS website, so no code editing is necessary.
