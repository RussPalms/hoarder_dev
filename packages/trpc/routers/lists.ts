import assert from "node:assert";
import { experimental_trpcMiddleware, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import invariant from "tiny-invariant";
import { z } from "zod";

import { SqliteError } from "@hoarder/db";
import { bookmarkLists, bookmarksInLists } from "@hoarder/db/schema";
import {
  zBookmarkListSchema,
  zEditBookmarkListSchemaWithValidation,
  zNewBookmarkListSchema,
} from "@hoarder/shared/types/lists";

import type { Context } from "../index";
import { authedProcedure, router } from "../index";
import { ensureBookmarkOwnership } from "./bookmarks";

export const ensureListOwnership = experimental_trpcMiddleware<{
  ctx: Context;
  input: { listId: string };
}>().create(async (opts) => {
  const list = await opts.ctx.db.query.bookmarkLists.findFirst({
    where: eq(bookmarkLists.id, opts.input.listId),
    columns: {
      userId: true,
    },
  });
  if (!opts.ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User is not authorized",
    });
  }
  if (!list) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "List not found",
    });
  }
  if (list.userId != opts.ctx.user.id) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "User is not allowed to access resource",
    });
  }

  return opts.next();
});

export const listsAppRouter = router({
  create: authedProcedure
    .input(zNewBookmarkListSchema)
    .output(zBookmarkListSchema)
    .mutation(async ({ input, ctx }) => {
      const [result] = await ctx.db
        .insert(bookmarkLists)
        .values({
          name: input.name,
          icon: input.icon,
          userId: ctx.user.id,
          parentId: input.parentId,
          type: input.type,
          query: input.query,
        })
        .returning();
      return result;
    }),
  edit: authedProcedure
    .input(zEditBookmarkListSchemaWithValidation)
    .output(zBookmarkListSchema)
    .use(ensureListOwnership)
    .mutation(async ({ input, ctx }) => {
      if (input.query) {
        const list = await ctx.db.query.bookmarkLists.findFirst({
          where: and(
            eq(bookmarkLists.id, input.listId),
            eq(bookmarkLists.userId, ctx.user.id),
          ),
        });
        // List must exist given that we passed the ownership check
        invariant(list);
        if (list.type !== "smart") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Manual lists cannot have a query",
          });
        }
      }
      const result = await ctx.db
        .update(bookmarkLists)
        .set({
          name: input.name,
          icon: input.icon,
          parentId: input.parentId,
          query: input.query,
        })
        .where(
          and(
            eq(bookmarkLists.id, input.listId),
            eq(bookmarkLists.userId, ctx.user.id),
          ),
        )
        .returning();
      if (result.length == 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return result[0];
    }),
  delete: authedProcedure
    .input(
      z.object({
        listId: z.string(),
      }),
    )
    .use(ensureListOwnership)
    .mutation(async ({ input, ctx }) => {
      const res = await ctx.db
        .delete(bookmarkLists)
        .where(
          and(
            eq(bookmarkLists.id, input.listId),
            eq(bookmarkLists.userId, ctx.user.id),
          ),
        );
      if (res.changes == 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
    }),
  addToList: authedProcedure
    .input(
      z.object({
        listId: z.string(),
        bookmarkId: z.string(),
      }),
    )
    .use(ensureListOwnership)
    .use(ensureBookmarkOwnership)
    .mutation(async ({ input, ctx }) => {
      const list = await ctx.db.query.bookmarkLists.findFirst({
        where: and(
          eq(bookmarkLists.id, input.listId),
          eq(bookmarkLists.userId, ctx.user.id),
        ),
      });
      invariant(list);
      if (list.type === "smart") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Smart lists cannot be added to",
        });
      }
      try {
        await ctx.db.insert(bookmarksInLists).values({
          listId: input.listId,
          bookmarkId: input.bookmarkId,
        });
      } catch (e) {
        if (e instanceof SqliteError) {
          if (e.code == "SQLITE_CONSTRAINT_PRIMARYKEY") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Bookmark ${input.bookmarkId} is already in the list ${input.listId}`,
            });
          }
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong",
        });
      }
    }),
  removeFromList: authedProcedure
    .input(
      z.object({
        listId: z.string(),
        bookmarkId: z.string(),
      }),
    )
    .use(ensureListOwnership)
    .use(ensureBookmarkOwnership)
    .mutation(async ({ input, ctx }) => {
      const deleted = await ctx.db
        .delete(bookmarksInLists)
        .where(
          and(
            eq(bookmarksInLists.listId, input.listId),
            eq(bookmarksInLists.bookmarkId, input.bookmarkId),
          ),
        );
      if (deleted.changes == 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Bookmark ${input.bookmarkId} is already not in list ${input.listId}`,
        });
      }
    }),
  get: authedProcedure
    .input(
      z.object({
        listId: z.string(),
      }),
    )
    .output(zBookmarkListSchema)
    .use(ensureListOwnership)
    .query(async ({ input, ctx }) => {
      const res = await ctx.db.query.bookmarkLists.findFirst({
        where: and(
          eq(bookmarkLists.id, input.listId),
          eq(bookmarkLists.userId, ctx.user.id),
        ),
      });
      if (!res) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return {
        id: res.id,
        name: res.name,
        icon: res.icon,
        parentId: res.parentId,
        type: res.type,
        query: res.query,
      };
    }),
  list: authedProcedure
    .output(
      z.object({
        lists: z.array(zBookmarkListSchema),
      }),
    )
    .query(async ({ ctx }) => {
      const lists = await ctx.db.query.bookmarkLists.findMany({
        where: and(eq(bookmarkLists.userId, ctx.user.id)),
      });

      return { lists };
    }),
  getListsOfBookmark: authedProcedure
    .input(z.object({ bookmarkId: z.string() }))
    .output(
      z.object({
        lists: z.array(zBookmarkListSchema),
      }),
    )
    .use(ensureBookmarkOwnership)
    .query(async ({ input, ctx }) => {
      const lists = await ctx.db.query.bookmarksInLists.findMany({
        where: and(eq(bookmarksInLists.bookmarkId, input.bookmarkId)),
        with: {
          list: true,
        },
      });
      assert(lists.map((l) => l.list.userId).every((id) => id == ctx.user.id));

      return { lists: lists.map((l) => l.list) };
    }),
});
