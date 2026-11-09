// <SignDialog> for React 18 and 19.
//
// React 19 can set custom-element properties and listen to custom events by
// itself; React 18 can do neither (it stringifies objects into attributes
// and ignores `onApprove`). This wrapper sets rich data as properties through
// a ref and adds the listeners itself, so both versions behave the same.
// It renders <soroban-sign-dialog>, so server rendering emits the tag and the
// browser upgrades it on hydration.
import { createElement, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { define, TAG } from './index.js';

const useIsoLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const PROPS = ['transaction', 'authEntries', 'network', 'signer', 'dapp', 'engine', 'rpcUrl', 'labels', 'strings', 'previewProvider', 'strict'];
const EVENTS = { onApprove: 'approve', onReject: 'reject', onPreview: 'preview', onOpen: 'open', onClose: 'close' };

export const SignDialog = forwardRef(function SignDialog(props, ref) {
  const el = useRef(null);
  const handlers = useRef(props);
  handlers.current = props;
  useImperativeHandle(ref, () => el.current, []);

  useIsoLayoutEffect(() => {
    define();
    for (const p of PROPS) if (props[p] !== undefined && el.current[p] !== props[p]) el.current[p] = props[p];
  });

  useEffect(() => {
    const node = el.current;
    const off = Object.entries(EVENTS).map(([prop, type]) => {
      const fn = (e) => handlers.current[prop]?.(e);
      node.addEventListener(type, fn);
      return () => node.removeEventListener(type, fn);
    });
    return () => off.forEach((f) => f());
  }, []);

  useEffect(() => {
    const node = el.current;
    if (props.open && !node.open) node.show();
    else if (props.open === false && node.open) node.close();
  }, [props.open, props.transaction, props.authEntries]);

  return createElement(TAG, {
    ref: el,
    class: props.className,
    id: props.id,
    theme: props.theme,
    preview: props.preview,
    inline: props.inline ? '' : undefined,
  }, props.children);
});
