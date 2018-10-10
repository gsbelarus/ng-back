import log4js from "log4js";
import {createStompServerSession, setLoggingListeners} from "node-stomp-protocol";
import WebSocket from "ws";
import {MainApplication} from "../apps/MainApplication";
import {StompSession} from "./StompSession";

export class StompManager {

  private readonly _logger = log4js.getLogger("STOMP");
  private readonly _mainApplication = new MainApplication();

  private _sessions = new Map<WebSocket, StompSession>();

  get mainApplication(): MainApplication {
    return this._mainApplication;
  }

  public add(webSocket: WebSocket): boolean {
    const stomp = createStompServerSession(webSocket, StompSession);
    const session = stomp.listener as StompSession;
    session.mainApplication = this._mainApplication;
    session.logger = this._logger;
    this._sessions.set(webSocket, session);
    return true;
  }

  public delete(webSocket: WebSocket): void {
    const session = this._sessions.get(webSocket);
    if (!session) {
      throw new Error("WebSocket not found");
    }
    this._sessions.delete(webSocket);
  }

  public async create(): Promise<void> {
    setLoggingListeners({
      error: console.log,
      info: console.log,
      silly: (message, args) => {
        const receiverDataTemplate = /^StompWebSocketStreamLayer: received data %.$/g;
        if (receiverDataTemplate.test(message)) {
          this._logger.info("\n>>> %s", args);
        }
        const sendingDataTemplate = /^StompFrameLayer: sending frame data %.$/g;
        if (sendingDataTemplate.test(message)) {
          args.startsWith("ERROR")
            ? this._logger.warn("\n<<< %s", args)
            : this._logger.info("\n<<< %s", args);
        }
      },
      warn: console.log,
      debug: () => ({})
    });

    await this._mainApplication.createOrConnect();
  }

  public async destroy(): Promise<void> {
    await this._mainApplication.disconnect();
  }
}
