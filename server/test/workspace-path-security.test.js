'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'shipyard-path-security-'));
const allowed=path.join(root,'allowed');const outside=path.join(root,'outside');
fs.mkdirSync(allowed);fs.mkdirSync(outside);
process.env.OPENTOFU_WORKSPACE_ROOTS=allowed;
const {workspacePath,confinedPath}=require('../features/opentofu/workspace-paths');
const {moveWorkspaceDirectory,syncOneToGit,syncOneFromGit,tofuGitDir,ensureProviderLockIsTracked}=require('../features/opentofu/workspace-files');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('workspace paths reject traversal, root operations, siblings and symlinked ancestors',()=>{
 for(const value of [allowed,outside,path.join(allowed,'../outside'),'relative/path',allowed+'-sibling/work'])assert.throws(()=>workspacePath(value));
 fs.symlinkSync(outside,path.join(allowed,'escape'));
 assert.throws(()=>workspacePath(path.join(allowed,'escape','new-directory')),/symbolic links/);
 assert.equal(workspacePath(path.join(allowed,'new','directory')),path.join(allowed,'new','directory'));
});
test('moving workspaces cannot escape or remove an overlapping parent',()=>{
 const source=path.join(allowed,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'main.tf'),'keep');
 assert.throws(()=>moveWorkspaceDirectory(source,outside));
 assert.throws(()=>moveWorkspaceDirectory(source,path.join(source,'nested')),/overlap/);
 assert.throws(()=>moveWorkspaceDirectory(source,path.join(allowed,'escape','moved')),/symbolic links/);
 assert.equal(fs.readFileSync(path.join(source,'main.tf'),'utf8'),'keep');
 assert.equal(moveWorkspaceDirectory(source,path.join(allowed,'moved')),true);
});
test('Git sync and lock-file editing cannot read or overwrite symlink targets',()=>{
 const source=path.join(allowed,'sync');fs.mkdirSync(source);
 const secret=path.join(outside,'secret');fs.writeFileSync(secret,'private');
 const name='path-security-'+process.pid;const dest=tofuGitDir(name);
 try {
  fs.symlinkSync(secret,path.join(source,'main.tf'));
  assert.throws(()=>syncOneToGit(name,source),/symbolic links/);
  fs.unlinkSync(path.join(source,'main.tf'));
  fs.mkdirSync(dest,{recursive:true});fs.symlinkSync(secret,path.join(dest,'main.tf'));
  assert.throws(()=>syncOneFromGit(name,source),/symbolic links/);
  fs.symlinkSync(secret,path.join(source,'.gitignore'));
  assert.throws(()=>ensureProviderLockIsTracked(source),/symbolic links/);
  assert.throws(()=>confinedPath(source,path.join(source,'.gitignore')),/symbolic links/);
  assert.equal(fs.readFileSync(secret,'utf8'),'private');
 }finally {fs.rmSync(dest,{recursive:true,force:true});}
});
