        // ── 首帧前预注册 companion 皮肤（插件补丁 · host-entry 版）─────────────
        //
        // dst 启动链：bin/dsh-tui.js -> startEntrySession(host-entry.js)
        //   -> apply() 内部 render() 画首帧 -> root.compose() 加载插件
        // 所以补丁必须在 apply() 之前执行，否则首帧已经画出内置宠物。
        //
        // 三处默认值都要补齐，缺一不可：
        //   companionSkinStore 初值 = 'deepy'
        //   COMPANION_SKIN_IDS  初值 = ['deepy','whaleGirl','whale']
        //   skins Map            初值 = 三个内置皮肤
        try {
            const { readFileSync: __pr, realpathSync: __prReal } = await import('node:fs');
            const { join: __pj } = await import('node:path');
            const { pathToFileURL: __pu } = await import('node:url');
            const { createRequire: __pcr } = await import('node:module');
            const { resolveDshHome: __phome } = await import('@deepseek-ai/dsh-home-paths');
            const __pHomeDir = process.env.DSH_HOME || __phome();
            const __pProf = process.env.DSH_PROFILE || profile;
            const __pDir = __pj(__pHomeDir, 'profiles', __pProf);
            const __pTui = __pj(__pDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
            const __pTypes = __pj(__pTui, 'lib', 'types');
            let __pWant;
            try {
                const __t = __pr(__pj(__pDir, 'cordis.patch.yml'), 'utf8').split(/\r?\n/);
                let __inRow = false, __inComp = false;
                for (const __raw of __t) {
                    const __l = __raw.replace(/#.*$/, '').replace(/\s+$/, '');
                    if (!__l.trim()) continue;
                    const __ind = __l.length - __l.trimStart().length;
                    if (__ind === 0 && /^-\s+id:/.test(__l)) { __inRow = /^-\s+id:\s*dsh-tui\s*$/.test(__l); __inComp = false; continue; }
                    if (!__inRow) continue;
                    if (__ind > 0 && /^\s+companion:\s*$/.test(__l)) { __inComp = true; continue; }
                    if (__inComp) {
                        const __m = /^\s+skin:\s*(\S+)\s*$/.exec(__l);
                        if (__m) { __pWant = __m[1].replace(/^['"]|['"]$/g, ''); break; }
                        if (/^\s+\w+:\s*$/.test(__l)) __inComp = false;
                    }
                }
            } catch { /* 无用户层 */ }
            if (__pWant) {
                const __pPrefs = await import(__pu(__pj(__pTypes, 'tuiDisplayPrefs.js')).href);
                if (!__pPrefs.COMPANION_SKIN_IDS.includes(__pWant)) {
                    let __pBundles = [];
                    try { __pBundles = JSON.parse(__pr(__pj(__pDir, 'package.json'), 'utf8'))?.dsh?.profile?.bundles ?? []; } catch {}
                    const __pSkip = new Set(['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']);
                    for (const __nm of __pBundles) {
                        if (__pSkip.has(__nm) || __pPrefs.COMPANION_SKIN_IDS.includes(__pWant)) continue;
                        try {
                            let __pkg = __pj(__pDir, 'node_modules', __nm);
                            try { __pkg = __prReal(__pkg); } catch {}
                            const __skinMod = await import(__pu(__pj(__pkg, 'lib', 'skin.js')).href).catch(() => undefined);
                            if (!__skinMod || typeof __skinMod.createSkin !== 'function') continue;
                            const __cfg = (await import(__pu(__pj(__pkg, 'lib', 'config.js')).href)).resolveConfig({});
                            if (__cfg.skinId !== __pWant) continue;
                            const __kit = (await import(__pu(__pj(__pkg, 'lib', 'frames.js')).href)).loadKit();
                            if (!__kit) continue;
                            const __req = __pcr(__pu(__pj(__pTui, 'package.json')));
                            let __React;
                            try { __React = __req('react'); } catch { continue; }
                            const __ownSkins = await import(__pu(__pj(__pTypes, 'components', 'sidePanel', 'companion', 'skins.js')).href);
                            const __ownWhale = await import(__pu(__pj(__pTypes, 'components', 'Whale.js')).href);
                            const __ownUi = await import(__pu(__pj(__pTypes, 'ui.js')).href);
                            const __ownHooks = await import(__pu(__pj(__pTypes, 'ink', 'hooks', 'use-terminal-images.js')).href);
                            const __ownCtx = await import(__pu(__pj(__pTypes, 'components', 'sidePanel', 'SidePanelRuntimeContext.js')).href);
                            __skinMod.setHostDeps({
                                Box: __ownUi.Box, Text: __ownUi.Text, Image: __ownUi.Image,
                                renderSpriteRows: __ownWhale.renderSpriteRows,
                                useTerminalImages: __ownHooks.useTerminalImages,
                                useTerminalImageProtocol: __ownHooks.useTerminalImageProtocol,
                                useSidePanelChannel: __ownCtx.useSidePanelChannel,
                            });
                            const __ani = await import(__pu(__pj(__pkg, 'lib', 'animations.js')).href);
                            const __reg = await import(__pu(__pj(__pkg, 'lib', 'register.js')).href);
                            const __res = __ani.createResolver(__kit.animations, __cfg);
                            const __skin = __skinMod.createSkin({ React: __React, kit: __kit, resolver: __res, config: __cfg });
                            if (typeof __ownSkins.registerCompanionSkin !== 'function') continue;
                            __ownSkins.registerCompanionSkin(__skin);
                            __reg.appendSkinId({ COMPANION_SKIN_IDS: __pPrefs.COMPANION_SKIN_IDS }, __pWant);
                            break;
                        } catch { /* 下一个包 */ }
                    }
                }
                __pPrefs.applyCompanionSkin(__pWant);
            }
        } catch { /* 预注册失败不影响启动 */ }
