import type { Backend, BackendId } from "./contracts.ts";

export class BackendRegistry {
  private readonly backends = new Map<BackendId, Backend>();

  register(backend: Backend): this {
    this.backends.set(backend.id, backend);
    return this;
  }

  get(id: BackendId): Backend {
    const backend = this.backends.get(id);
    if (!backend) {
      throw new Error(`Backend is not registered: ${id}`);
    }
    return backend;
  }

  list(): Backend[] {
    return [...this.backends.values()];
  }

  async statuses(): Promise<Array<{ id: BackendId; displayName: string; available: boolean; detail?: string }>> {
    return Promise.all(
      this.list().map(async (backend) => {
        try {
          const status = backend.status ? await backend.status() : { available: true };
          return {
            id: backend.id,
            displayName: backend.displayName,
            available: status.available,
            detail: status.detail,
          };
        } catch (error) {
          return {
            id: backend.id,
            displayName: backend.displayName,
            available: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
}
