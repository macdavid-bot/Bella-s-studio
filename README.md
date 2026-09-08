# Bella's Studio

Bella's Studio is a private, single-user image editing web app designed to run on a small VPS. It keeps uploaded and generated images on the VPS filesystem and does not expose a public signup flow.

## VPS setup

The VPS needs Docker, Docker Compose, and Git. After the first clone:

```bash
cp .env.example .env
nano .env
bash deploy.sh
```

`bash deploy.sh` checks the required secrets, confirms Docker is running, pulls `main`, rebuilds the container, removes orphan containers, and prints the running status.

The container uses `restart: always`, so Docker brings it back after an application crash, container restart, or VPS reboot. On a fresh VPS, make sure Docker itself starts on boot:

```bash
sudo systemctl enable --now docker
```

Set these values in `.env` before starting:

- `APP_USERNAME`, `APP_PASSWORD`, and `SESSION_SECRET`
- `GEMINI_API_KEY`
- `REPLICATE_API_TOKEN`

The default Gemini model is the current stable `gemini-2.5-flash-image` model on the Gemini API. `GEMINI_MODEL` and `GEMINI_API_VERSION` remain configurable so the deployment can follow future Google model changes. Google API free-tier availability and limits depend on the account and region; this app cannot guarantee that provider usage will remain free.

The service listens on port `3000`. Put the subdomain behind your VPS reverse proxy and forward it to `127.0.0.1:3000`. The app sends `X-Robots-Tag: noindex, nofollow, noarchive` and has no signup route.

## What the pipeline does

1. Upscales the target with `nightmareai/real-esrgan`.
2. Sends reference images, the upscaled target, and the user's prompt to Gemini image generation.
3. Sends both the original target and Gemini result to `lucataco/sdxl-lightning-multi-controlnet`: the original target is the Canny identity/proportion guide, while the Gemini result is the OpenPose and img2img guide.
4. Runs `nightmareai/real-esrgan` again for final resolution and face enhancement.

`lucataco/sdxl-lightning-multi-controlnet` supports img2img and up to three simultaneous ControlNets. Its API names the inputs `image`, `controlnet_1_image`, `controlnet_2_image`, and so on; it does not accept a generic `control_image` list. The model returns its preprocessed control images before the generated result, so the server deliberately selects the final output.

Model calls run server-side. The frontend only shows a single friendly generation state, not provider internals.

## Storage

Generated jobs live under `DATA_DIR/jobs`. Completed jobs older than `MAX_AGE_DAYS` are removed automatically. If the directory grows beyond `MAX_STORAGE_GB`, the oldest non-running jobs are removed until at least 5GB has been cleared.

The Docker Compose file applies the requested `150m` memory and `0.2` CPU limits. The limits constrain the app container; image generation compute and temporary provider-side processing happen in Gemini and Replicate.

For the memory limit, the app defaults to 8MB per uploaded image and allows only one active generation at a time. Gemini and Replicate perform the GPU-heavy image work outside the VPS container.