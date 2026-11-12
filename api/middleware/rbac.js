'use strict';
/**
 * RBAC MIDDLEWARE
 * Usage:  router.get('/hotels', requireAuth, can('hotels','view'), handler)
 */

// Default permissions per role
const ROLE_DEFAULTS = {
  superadmin: { _all: true },
  admin: {
    dash:true, hotels:{view:true,add:true,edit:true,del:true,exp:true},
    vendors:{view:true,add:true,edit:true,del:true},
    search:true, ratelist:{view:true,exp:true},
    queries:{view:true,add:true,edit:true,del:true},
    quotations_pvt:{view:true,add:true,edit:true,del:true},
    quotations_grp:{view:true,add:true,edit:true,del:true},
    allquot:{view:true,add:true,edit:true,del:true},
    transport:{view:true,add:true,edit:true,del:true},
    import:{view:true,imp:true,exp:true},
    images:{view:true,add:true,del:true},
    users:{view:true,add:true,edit:true,del:true},
    branches:{view:true},
    logs:{view:true}, recycle:{view:true,del:true},
    backup:{view:true}, settings:{view:true},
    dedup:{view:true,del:true}
  },
  branch_admin: {
    dash:true, hotels:{view:true}, search:true,
    ratelist:{view:true,exp:true},
    queries:{view:true,add:true,edit:true},
    quotations_pvt:{view:true,add:true,edit:true,del:true},
    quotations_grp:{view:true,add:true,edit:true,del:true},
    allquot:{view:true}, transport:{view:true},
    import:{view:true,exp:true},
    images:{view:true,add:true}, users:{view:true,add:true,edit:true},
    branches:{view:true,edit:true},
    logs:{view:true}, recycle:{view:true}, settings:{view:true,edit:true}
  },
  editor: {
    dash:true, hotels:{view:true,add:true,edit:true,exp:true},
    vendors:{view:true,add:true,edit:true}, search:true,
    ratelist:{view:true,exp:true},
    queries:{view:true,add:true,edit:true},
    quotations_pvt:{view:true,add:true,edit:true},
    quotations_grp:{view:true,add:true,edit:true},
    transport:{view:true,add:true,edit:true},
    import:{view:true,imp:true,exp:true}, images:{view:true,add:true}
  },
  viewer: {
    dash:true, hotels:{view:true}, search:true,
    ratelist:{view:true}, queries:{view:true},
    quotations_pvt:{view:true}, quotations_grp:{view:true},
    transport:{view:true}, packages:{view:true,add:true}
  },
  user: {
    dash:true, search:true, ratelist:{view:true},
    quotations_pvt:{view:true,add:true,edit:true},
    quotations_grp:{view:true,add:true,edit:true},
    transport:{view:true}
  }
};

function hasPerm(user, module, action = 'view') {
  if (!user) return false;
  const defaults = ROLE_DEFAULTS[user.role] || {};
  if (defaults._all) return true; // superadmin

  // Check granular user permissions first (overrides)
  const up = user.permissions || {};
  if (up[module] !== undefined) {
    if (typeof up[module] === 'boolean') return up[module];
    if (up[module][action] !== undefined) return !!up[module][action];
  }

  // Fall back to role defaults
  const rm = defaults[module];
  if (!rm) return false;
  if (typeof rm === 'boolean') return rm;
  return !!rm[action];
}

// Express middleware factory
function can(module, action = 'view') {
  return (req, res, next) => {
    if (!hasPerm(req.user, module, action)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    next();
  };
}

module.exports = { hasPerm, can };
