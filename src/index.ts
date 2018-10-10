import config from "config";
import http, {Server as HttpServer} from "http";
import Koa from "koa";
import koaBody from "koa-body";
import errorHandler from "koa-error";
import logger from "koa-logger";
import Router from "koa-router";
import send from "koa-send";
import serve from "koa-static";
import cors from "koa2-cors";
import log4js from "log4js";
import path from "path";
import WebSocket from "ws";
import {checkHandledError, ErrorCodes, throwCtx} from "./ErrorCodes";
import passport from "./passport";
import account from "./router/account";
import {StompManager} from "./stomp/StompManager";

interface IServer {
  stompManager: StompManager;
  httpServer?: HttpServer;
  wsServer: WebSocket.Server;
}

process.env.NODE_ENV = process.env.NODE_ENV || "development";

log4js.configure("./config/log4js.json");
const defaultLogger = log4js.getLogger();

async function create(): Promise<IServer> {
  const stompManager = new StompManager();
  await stompManager.create();

  const serverApp = new Koa()
    .use(logger())
    .use(serve(config.get("server.publicDir")))
    .use(koaBody({multipart: true}))
    .use(passport.initialize())
    .use(cors())
    .use(errorHandler())
    .use(async (ctx, next) => {
      try {
        await next();
      } catch (error) {
        if (checkHandledError(error)) {
          throw error;
        }
        throwCtx(ctx, 500, error, ErrorCodes.INTERNAL);
      }
    });

  serverApp.use(async (ctx, next) => {
    ctx.state.mainApplication = stompManager.mainApplication;
    await next();
  });

  const router = new Router()
    .use("/account", account.routes(), account.allowedMethods())

    // TODO temp
    .get("/", (ctx) => ctx.redirect("/spa"))
    .get(/\/spa(\/*)?/g, async (ctx) => {
      await send(ctx, "/gs/ng/", {
        root: path.resolve(process.cwd(), config.get("server.publicDir")),
        index: "index",
        extensions: ["html"]
      });
    });

  serverApp
    .use(router.routes())
    .use(router.allowedMethods())
    .use((ctx) => throwCtx(ctx, 404, "Not found", ErrorCodes.NOT_FOUND));

  const httpServer = startHttpServer(serverApp);

  const wsServer = new WebSocket.Server({server: httpServer});
  wsServer.on("connection", (webSocket) => {
    defaultLogger.info("WebSocket event: 'connection'");
    if (stompManager.add(webSocket)) {
      webSocket.on("close", () => {
        defaultLogger.info("WebSocket event: 'close'");
        stompManager.delete(webSocket);
      });
    }
  });

  return {
    stompManager,
    httpServer,
    wsServer
  };
}

function startHttpServer(serverApp: Koa): HttpServer | undefined {
  let httpServer: HttpServer | undefined;
  if (config.get("server.http.enabled")) {
    httpServer = http.createServer(serverApp.callback());
    httpServer.listen(config.get("server.http.port"), config.get("server.http.host"));
    httpServer.on("error", serverErrorHandler);
    httpServer.on("listening", () => {
      const address = httpServer!.address();
      if (typeof address === "string") {
        defaultLogger.info(`Listening ${httpServer!.address()}`);
      } else {
        defaultLogger.info(`Listening on http://%s:%s;` +
          ` env: %s`, address.address, address.port, process.env.NODE_ENV);
      }
    });
  }
  return httpServer;
}

const creating = create();

process.on("SIGINT", exit);
process.on("SIGTERM", exit);

async function exit(): Promise<void> {
  try {
    const {stompManager, httpServer, wsServer} = await creating;

    await new Promise((resolve) => wsServer.close(resolve));

    if (httpServer) {
      httpServer.removeAllListeners();
      await new Promise((resolve) => httpServer.close(resolve));
    }
    await stompManager.destroy();

    await new Promise((resolve, reject) => log4js.shutdown((error) => error ? reject(error) : resolve()));
  } catch (error) {
    switch (error.message) {
      case "connection shutdown":
        // ignore
        break;
      default:
        defaultLogger.error(error);
    }
  } finally {
    defaultLogger.info("Server destroyed");
    process.exit();
  }
}

function serverErrorHandler(error: NodeJS.ErrnoException): void {
  if (error.syscall !== "listen") {
    throw error;
  }
  switch (error.code) {
    case "EACCES":
      defaultLogger.error("Port requires elevated privileges");
      process.exit();
      break;
    case "EADDRINUSE":
      defaultLogger.error("Port is already in use");
      process.exit();
      break;
    default:
      throw error;
  }
}
