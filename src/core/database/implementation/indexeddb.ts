import { Storable, Database, DatabaseConfig } from '../types';
import { Storage, StorageFactory } from '../storage';


class IndexedDBStorage<T extends Storable> implements Storage<T> {
    private dbName: string;
    private version: number;
    private storeName: string;
    private db: IDBDatabase | null = null;

    constructor(config: DatabaseConfig) {
      this.dbName = config.databaseName;
      this.version = config.version || 1;
      this.storeName = config.storeName || 'BrowserAIStore';

    }


    private async openDatabase(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            if(this.db){
                resolve(this.db)
                return;
            }

          let request = indexedDB.open(this.dbName, this.version);

          request.onerror = (event) => {
            reject(`Database error: ${(event.target as IDBRequest).error}`);
          };

          request.onsuccess = (event) => {
            this.db = (event.target as IDBRequest).result;
            resolve(this.db);
          };

           request.onupgradeneeded = (event) => {
            let db = (event.target as IDBRequest).result;

            if (!db.objectStoreNames.contains(this.storeName)) {
              db.createObjectStore(this.storeName, { keyPath: 'id' });
            }
          };
        });
      }


    async store(data: T): Promise<void> {
         let db = await this.openDatabase();
        return new Promise((resolve, reject) => {
          let transaction = db.transaction([this.storeName], 'readwrite');
          let store = transaction.objectStore(this.storeName);
          let request = store.add(data);

          request.onsuccess = () => resolve();
          request.onerror = (event) => reject(`Error storing data: ${(event.target as IDBRequest).error}`);
        });
      }

      async get(id: string): Promise<T | undefined> {
        let db = await this.openDatabase();
        return new Promise((resolve, reject) => {
          let transaction = db.transaction([this.storeName], 'readonly');
          let store = transaction.objectStore(this.storeName);
          let request = store.get(id);

          request.onsuccess = (event) => resolve((event.target as IDBRequest).result as T);
          request.onerror = (event) => reject(`Error getting data: ${(event.target as IDBRequest).error}`);
        });
      }

     async getAll(): Promise<T[]> {
         let db = await this.openDatabase();
        return new Promise((resolve, reject) => {
          let transaction = db.transaction([this.storeName], 'readonly');
          let store = transaction.objectStore(this.storeName);
          let request = store.getAll();

          request.onsuccess = (event) => resolve((event.target as IDBRequest).result as T[]);
          request.onerror = (event) => reject(`Error getting data: ${(event.target as IDBRequest).error}`);
        });
      }


    async update(data: T): Promise<void> {
        let db = await this.openDatabase();
        return new Promise((resolve, reject) => {
          let transaction = db.transaction([this.storeName], 'readwrite');
          let store = transaction.objectStore(this.storeName);
          let request = store.put(data);

          request.onsuccess = () => resolve();
          request.onerror = (event) => reject(`Error updating data: ${(event.target as IDBRequest).error}`);
        });
      }

    async delete(id: string): Promise<void> {
        let db = await this.openDatabase();
        return new Promise((resolve, reject) => {
          let transaction = db.transaction([this.storeName], 'readwrite');
          let store = transaction.objectStore(this.storeName);
          let request = store.delete(id);

          request.onsuccess = () => resolve();
          request.onerror = (event) => reject(`Error deleting data: ${(event.target as IDBRequest).error}`);
        });
      }

     async clear(): Promise<void> {
        let db = await this.openDatabase();
         return new Promise((resolve, reject) => {
          let transaction = db.transaction([this.storeName], 'readwrite');
          let store = transaction.objectStore(this.storeName);
          let request = store.clear();

          request.onsuccess = () => resolve();
          request.onerror = (event) => reject(`Error clearing data: ${(event.target as IDBRequest).error}`);
        });
    }


    close(): void {
        if(this.db){
            this.db.close()
            this.db = null
        }
      }
  }


 export class IndexedDBStorageFactory<T extends Storable> implements StorageFactory<T>{
   async createStorage(type: string, config: DatabaseConfig): Promise<Storage<T>> {
       if(type !== 'indexeddb'){
           throw new Error(`invalid type ${type}`);
       }
       return new IndexedDBStorage<T>(config);
   }
}