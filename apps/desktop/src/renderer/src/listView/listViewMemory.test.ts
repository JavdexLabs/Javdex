import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { clearAllListViewMemory, clearListScrollForPrimaryNav, getListScroll, resolveScrollTopForKey, setListScroll } from './listViewMemory'
afterEach(clearAllListViewMemory)
it('keeps twenty recent numeric anchors, resets filter changes and clears primary navigation',()=>{
  for(let i=0;i<20;i++)setListScroll(`actresses:${i}`,{scrollTop:i*100,visibleRowIndex:i})
  setListScroll('actresses:0',{scrollTop:42})
  setListScroll('actresses:20',{scrollTop:2000})
  assert.equal(getListScroll('actresses:1'),undefined)
  assert.equal(resolveScrollTopForKey(undefined,'actresses:0'),42)
  assert.equal(resolveScrollTopForKey('actresses:0','actresses:20'),0)
  clearListScrollForPrimaryNav('/actresses')
  assert.equal(getListScroll('actresses:0'),undefined)
})
