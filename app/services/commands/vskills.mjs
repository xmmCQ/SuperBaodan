export function registerVSkillCommands(commands) {
  commands.set('vskills.list',async(args,context)=>({vskills:await context.vskillManager.list()}));
  commands.set('vskills.create',async(args,context)=>({ok:true,vskill:await context.vskillManager.create(args)}));
  commands.set('vskills.update',async(args,context)=>({ok:true,vskill:await context.vskillManager.update(args.id,args)}));
  commands.set('vskills.delete',async(args,context)=>({ok:true,deleted:await context.vskillManager.delete(args.id)}));
}
