﻿'use strict';

/**
 * @module Editor
 */
let Ipc = {};
module.exports = Ipc;

// requires
const Electron = require('electron');

const Window = require('./window');
const Package = require('./package');
const Panel = require('./panel');
const Console = require('./console');

let _nextSessionId = 1000;
let _replyCallbacks = {};

// ========================================
// exports
// ========================================

// initialize messages APIs

/**
 * This option is used to indicate that the message should not send to self.
 * It must be supplied as the last argument of your message if you want.
 * @property excludeSelf
 * @type {Object}
 */
Ipc.excludeSelf = {
  '__ipc__': true,
  'exclude': 'self',
};

/**
 * Send `message` with `...args` to all opened windows asynchronously. The renderer process
 * can handle it by listening to the message through the `Electron.ipcRenderer` module.
 *
 * @method sendToWins
 * @param {string} message
 * @param {...*} [args] - whatever arguments the message needs
 * @example
 * In `core-level`:
 *
 * ```js
 * Ipc.sendToWins('foo:bar', 'Hello World!');
 * ```
 *
 * In `page-level`:
 *
 * ```html
 * // index.html
 * <html>
 * <body>
 *   <script>
 *     require('ipc').on('foo:bar', function(text) {
 *       console.log(text);  // Prints "Hello World!"
 *     });
 *   </script>
 * </body>
 * </html>
 * ```
 */
Ipc.sendToWins = _send2wins;

/**
 * Send `message` with `...args` to all opened window and to main process asynchronously.
 * @method sendToAll
 * @param {string} message
 * @param {...*} [args] - whatever arguments the message needs
 */
Ipc.sendToAll = function (message, ...args) {
  if (args.length) {
    let excludeSelf = false;
    let opt = _popOption(args);

    // check options
    if (opt && opt.exclude === 'self') {
      excludeSelf = true;
    }

    args = [message, ...args];

    // send
    if (!excludeSelf) {
      _main2main.apply(null, args);
    }
    _send2wins.apply(null, args);

    return;
  }

  _main2main(message);
  _send2wins(message);
};

// DISABLE: not make sense
// Ipc.sendToPackage = function ( packageName, message ) {
//     var panels = Editor.Panel.findPanels(packageName);
//     var args = [].slice.call( arguments, 1 );
//
//     for ( var i = 0; i < panels.length; ++i ) {
//         var panelID = packageName + '.' + panels[i];
//         Ipc.sendToPanel.apply( null, [panelID].concat(args) );
//     }
// };

/**
 * Send `message` with `...args` to main process asynchronously.
 * @method sendToMain
 * @param {string} message
 * @param {...*} [args] - whatever arguments the message needs
 */
Ipc.sendToMain = function (message, ...args) {
  args = [message, ...args];

  if ( _main2main.apply ( null, args ) === false ) {
    Console.failed( `sendToMain "${message}" failed, not responded.` );
  }
};

/**
 * Send `message` with `...args` to specific panel asynchronously.
 * @method sendToPanel
 * @param {string} panelID
 * @param {string} message
 * @param {...*} [args] - whatever arguments the message needs
 * @example
 * ```js
 * Ipc.sendToPanel( 'package.panel', 'foo-bar', 'foo', 'bar' );
 * ```
 */
Ipc.sendToPanel = function (panelID, message, ...args) {
  let win = Panel.findWindow( panelID );
  if ( !win ) {
    // Console.warn( "Failed to send %s, can not find panel %s.", message, panelID );
    return;
  }

  let panelInfo = Package.panelInfo(panelID);
  if ( !panelInfo ) {
    return;
  }

  // ignore the panelID
  if ( panelInfo.type === 'simple' ) {
    win.sendToPage.apply( win, [message, ...args] );
    return;
  }

  //
  win.sendToPage.apply( win, ['editor:send2panel', panelID, message, ...args] );
};

/**
 * Send `message` with `...args` to main window asynchronously.
 * @method sendToMainWin
 * @param {string} message
 * @param {...*} [args] - whatever arguments the message needs
 */
Ipc.sendToMainWin = function (message, ...args) {
  let mainWin = Window.main;
  if ( !mainWin ) {
    // NOTE: do not use Editor.error here, since it will lead to ipc loop
    console.error(`Failed to send "${message}" to main window, the main window is not found.`);
    return;
  }

  mainWin.sendToPage.apply( mainWin, [message, ...args] );
};

/**
 * Send `message` with `...args` to main process asynchronously and wait for the reply.
 * @method sendRequestToCore
 * @param {string} message
 * @param {...*} [args] - whatever arguments the request needs
 * @param {function} callback - the callback used to handle replied arguments
 * @return {number} - The session id, it can be used in Editor.cancelRequestToCore
 */
Ipc.sendRequestToCore = function (message, ...args) {
  if (typeof message !== 'string') {
    Console.error('The message must be string');
    return null;
  }

  if ( !args.length ) {
    Console.error('Invalid arguments, reply function not found!');
    return null;
  }

  let reply = args[args.length - 1];
  if (typeof reply !== 'function') {
    Console.error('The last argument must be function');
    return null;
  }

  // pop reply function
  args.pop();

  let sessionId = _nextSessionId++;
  _replyCallbacks[sessionId] = reply;

  _main2main('editor:sendreq2core', message, sessionId, args);
  return sessionId;
};

/**
 * Cancel request sent to core by sessionId
 * @method cancelRequestToCore
 * @param {number} sessionId
 */
Ipc.cancelRequestToCore = function (sessionId) {
  delete _replyCallbacks[sessionId];
};

// ========================================
// Internal
// ========================================

function _popOption (args) {
  let opt = args[args.length - 1];

  if ( opt && typeof opt === 'object' && opt.__ipc__ ) {
    args.splice(-1,1);
    return opt;
  }

  return null;
}

function _send2wins (message, ...args) {
  args = [message, ...args];

  // NOTE: duplicate windows list since window may close during events
  let winlist = Window.windows.slice();
  for ( let i = 0; i < winlist.length; ++i ) {
    let win = winlist[i];
    win.sendToPage.apply( win, args );
  }
}

/**
 * Send `args...` to windows except the excluded
 * @method _main2renderersExclude
 * @param {object} excluded - A [WebContents](https://github.com/atom/electron/blob/master/docs/api/browser-window.md#class-webcontents) object.
 * @param {...*} [args] - whatever arguments the message needs
 */
function _main2renderersExclude (excluded, ...args) {
  // NOTE: duplicate windows list since window may close during events
  let winlist = Window.windows.slice();
  for ( let i = 0; i < winlist.length; ++i ) {
    let win = winlist[i];
    if (win.nativeWin.webContents !== excluded) {
      win.sendToPage.apply( win, args );
    }
  }
}

function _main2renderers (message, ...args) {
  if ( args.length === 0 ) {
    _send2wins( message );
    return;
  }

  // send
  _send2wins.apply( null, [message, ...args] );
}

function _main2main (message, ...args) {
  let event = {
    senderType: 'main',
    sender: {
      send (...args) {
        _main2main.apply ( null, args );
      }
    }
  };

  if ( args.length === 0 ) {
    return ipcMain.emit( message, event );
  }

  // insert event as 2nd parameter in args
  args = [message, event, ...args];
  return ipcMain.emit.apply ( ipcMain, args );

}

function _renderer2main (event, message, ...args) {
  if ( args.length === 0 ) {
    return ipcMain.emit( message, event );
  }

  // refine the args
  args = [message, event, ...args];
  return ipcMain.emit.apply ( ipcMain, args );
}

function _renderer2renderers (event, message, ...args) {
  // check options
  let opt = _popOption(args);

  if (opt && opt.exclude === 'self') {
    _main2renderersExclude.apply( null, [event.sender, message, ...args] );
    return;
  }

  _main2renderers.apply(null, [message, ...args]);
}

// ========================================
// Ipc
// ========================================

const ipcMain = Electron.ipcMain;

// DELME
// ipcMain.on('editor:send2core', function ( event, message ) {
//   if ( !_renderer2main.apply ( null, arguments ) ) {
//     Console.failed( `send2core "${message}" failed, listener not found for "${message}" in core-level` );
//   }
// });

ipcMain.on('editor:send2wins', _renderer2renderers );

ipcMain.on('editor:send2mainwin', (event, message, ...args) => {
  let mainWin = Window.main;
  if (!mainWin) {
    // NOTE: do not use Console.error here, since it will lead to ipc loop
    console.error(`Failed to send "${message}" because main page not initialized.`);
    return;
  }

  if (args.length) {
    // discard event arg
    mainWin.sendToPage.apply( mainWin, [event, message, ...args] );
  } else {
    mainWin.sendToPage( message );
  }
});

ipcMain.on('editor:send2all', (event, message, ...args) => {
  // check options
  let opt = _popOption(args);

  _renderer2main.apply(null, [event, message, ...args]);

  if (opt && opt.exclude === 'self') {
    _main2renderersExclude.apply( null, [event.sender, message, ...args] );
  } else {
    _main2renderers.apply(null, [message, ...args]);
  }
});

ipcMain.on('editor:send2panel', (event, panelID, message, ...args) => {
  Ipc.sendToPanel.apply( null, [panelID, message, ...args] );
});

ipcMain.on('editor:sendreq2core', (event, message, sessionId, args) => {
  let called = false;
  function _replyCallback (...args) {
    if ( called ) {
      Console.error(`The callback which reply to "${message}" can only be called once!`);
      return;
    }

    called = true;
    event.sender.send('editor:sendreq2core:reply', sessionId, args);
  }

  args = [event, message, _replyCallback, ...args];
  if ( !_renderer2main.apply(null, args) ) {
    Console.error(`The listener of message "${message}" is not yet registered!`);
  }
});

ipcMain.on('editor:sendreq2core:reply', (event, sessionId, args) => {
  let cb = _replyCallbacks[sessionId];
  if (cb) {
    // NOTE: we must delete callback before it apply, this will prevent window close in
    // reply-callback will still keep reference in GC
    delete _replyCallbacks[sessionId];
    cb.apply(null, args);
  }
});