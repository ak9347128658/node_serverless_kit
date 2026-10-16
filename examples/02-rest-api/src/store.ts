/**
 * In-memory book store.
 *
 * This keeps the example dependency-free. A real service must use a database
 * (DynamoDB, Firestore, Cosmos DB, D1, PostgreSQL, ...): serverless instances are
 * created and destroyed at any time and do NOT share memory, so data stored here
 * lives only as long as one warm instance.
 */

export interface Book {
  id: string;
  title: string;
  author: string;
  year: number;
  isbn: string;
}

const books = new Map<string, Book>([
  ["b1", { id: "b1", title: "Dune", author: "Frank Herbert", year: 1965, isbn: "9780441013593" }],
  ["b2", { id: "b2", title: "Neuromancer", author: "William Gibson", year: 1984, isbn: "9780441569595" }],
]);

export function listBooks(author?: string): Book[] {
  let all = [...books.values()];
  if (author) all = all.filter((b) => b.author.toLowerCase().includes(author.toLowerCase()));
  return all.sort((a, b) => a.title.localeCompare(b.title));
}

export function getBook(id: string): Book | undefined {
  return books.get(id);
}

export function findByIsbn(isbn: string): Book | undefined {
  return [...books.values()].find((b) => b.isbn === isbn);
}

export function putBook(book: Omit<Book, "id"> & { id?: string }): Book {
  const stored: Book = { ...book, id: book.id ?? crypto.randomUUID().slice(0, 8) };
  books.set(stored.id, stored);
  return stored;
}

export function deleteBook(id: string): boolean {
  return books.delete(id);
}

export function count(): number {
  return books.size;
}
