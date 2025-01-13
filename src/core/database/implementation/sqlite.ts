import { Storable, DatabaseConfig } from '../types';
import { Storage, StorageFactory } from '../storage';

export class SqliteStorage<T extends Storable> implements Storage<T> {
    private db: IDBDatabase | null = null;
    private readonly storeName: string;

    constructor(config: DatabaseConfig) {
        this.storeName = config.databaseName || 'defaultStore';
        this.initDatabase();
    }

    private async initDatabase(): Promise<void> {
        return new Promise((resolve, reject) => {
            let request = indexedDB.open(this.storeName, 1);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                let db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
        });
    }

    async store(data: T): Promise<void> {
        await this.ensureDbReady();
        return new Promise((resolve, reject) => {
            let transaction = this.db!.transaction([this.storeName], 'readwrite');
            let store = transaction.objectStore(this.storeName);
            let request = store.add(data);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async get(id: string): Promise<T | undefined> {
        await this.ensureDbReady();
        return new Promise((resolve, reject) => {
            let transaction = this.db!.transaction([this.storeName], 'readonly');
            let store = transaction.objectStore(this.storeName);
            let request = store.get(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || undefined);
        });
    }

    async getAll(): Promise<T[]> {
        await this.ensureDbReady();
        return new Promise((resolve, reject) => {
            let transaction = this.db!.transaction([this.storeName], 'readonly');
            let store = transaction.objectStore(this.storeName);
            let request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    async update(data: T): Promise<void> {
        await this.ensureDbReady();
        return new Promise((resolve, reject) => {
            let transaction = this.db!.transaction([this.storeName], 'readwrite');
            let store = transaction.objectStore(this.storeName);
            let request = store.put(data);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async delete(id: string): Promise<void> {
        await this.ensureDbReady();
        return new Promise((resolve, reject) => {
            let transaction = this.db!.transaction([this.storeName], 'readwrite');
            let store = transaction.objectStore(this.storeName);
            let request = store.delete(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async clear(): Promise<void> {
        await this.ensureDbReady();
        return new Promise((resolve, reject) => {
            let transaction = this.db!.transaction([this.storeName], 'readwrite');
            let store = transaction.objectStore(this.storeName);
            let request = store.clear();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    private async ensureDbReady(): Promise<void> {
        if (!this.db) {
            await this.initDatabase();
        }
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

export class SqliteStorageFactory<T extends Storable> implements StorageFactory<T> {
    async createStorage(type: string, config: DatabaseConfig): Promise<Storage<T>> {
        if(type !== 'sqlite'){
           throw new Error(`invalid type ${type}`);
       }
      return new SqliteStorage<T>(config);
    }
}