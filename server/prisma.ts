import prismaClientPkg from "@prisma/client";
import type { PrismaClient as PrismaClientType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const PrismaClient = (
  prismaClientPkg as unknown as {
    PrismaClient: new (...args: any[]) => PrismaClientType;
  }
).PrismaClient;

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClientType;
};

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
