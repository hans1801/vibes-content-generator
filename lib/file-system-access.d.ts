// lib.dom.d.ts doesn't declare FileSystemDirectoryHandle.entries() yet, even
// though Chrome implements it (File System Access API spec). Augment the
// global type here instead of casting through `unknown` at every call site.
export {};

declare global {
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }

  // Permissions API for File System Access handles — also missing from
  // lib.dom.d.ts. Lives on the base handle since both file and directory
  // handles support it.
  interface FileSystemHandle {
    requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  }

  // Entry point of the picker flow — also not in lib.dom.d.ts yet.
  function showDirectoryPicker(options?: {
    mode?: 'read' | 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
}
