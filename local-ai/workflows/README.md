# Registered ComfyUI workflows

1 workflow = 1 directory.

Required files:

- `manifest.json`
- ComfyUI API-format workflow JSON (default: `workflow-api.json`)

Example manifest:

```json
{
  "name": "Image basic",
  "type": "image",
  "workflowFile": "workflow-api.json",
  "bindings": {
    "prompt": { "node": "6", "input": "text" },
    "negativePrompt": { "node": "7", "input": "text" },
    "seed": { "node": "3", "input": "seed" },
    "steps": { "node": "3", "input": "steps" },
    "width": { "node": "5", "input": "width" },
    "height": { "node": "5", "input": "height" }
  }
}
```

Do not put model files in this directory.
