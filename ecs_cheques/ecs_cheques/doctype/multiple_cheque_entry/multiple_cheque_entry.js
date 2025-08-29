// Copyright (c) 2021, erpcloud.systems and contributors
// For license information, please see license.txt
frappe.ui.form.on("Multiple Cheque Entry", {
    setup: function(frm) {
        frm.set_query("bank_acc", () => ({
            filters: [["Bank Account", "bank", "in", frm.doc.cheque_bank]]
        }));
        frm.set_query("cheque_bank", () => ({
            filters: [["Bank", "company_bank", "=", '1']]
        }));
        frm.set_query("mode_of_payment", () => ({
            filters: [["Mode of Payment", "type", "=", 'Cheque']]
        }));
        frm.set_query("party_type", () => ({
            filters: [["DocType", "name", "in", ["Customer", "Supplier"]]]
        }));
    }
});
frappe.ui.form.on("Multiple Cheque Entry", {
    party_type: function(frm) {
        frm.set_value("party", "");
        frm.set_value("party_name", "");
    },
    cheque_bank: function(frm) {
        frm.set_value("bank_acc", "");
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    bank_acc: function(frm) {
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    payment_type: function(frm) {
        if (frm.doc.payment_type === "Receive") {
            frm.set_value("party_type", "Customer");
        }
        if (frm.doc.payment_type === "Pay") {
            frm.set_value("party_type", "Supplier");
        }
    },
    party: function(frm) {
        if (!frm.doc.party_type || !frm.doc.party) return;
        const doctype = frm.doc.party_type === "Customer" ? "Customer" : "Supplier";
        const fieldname = frm.doc.party_type === "Customer" ? "customer_name" : "supplier_name";
        frappe.call({
            method: "frappe.client.get_value",
            args: { doctype, fieldname, filters: { name: frm.doc.party } },
            callback: function(r) {
                frm.set_value("party_name", r.message ? r.message[fieldname] : "");
            }
        });
    },
    validate: function(frm) {
        if (frm.doc.mode_of_payment_type !== "Cheque") {
            frappe.throw("The selected Mode of Payment is not Cheque. Please select a Cheque type.");
        }
        
        // Validate child table data
        const isPay = frm.doc.payment_type === "Pay";
        const isReceive = frm.doc.payment_type === "Receive";
        const table = isPay ? frm.doc.cheque_table_2 : frm.doc.cheque_table;
        
        if (!table || !table.length) {
            frappe.throw("Please add cheque entries before submitting.");
        }
        
        table.forEach(row => {
            if (!row.account_paid_to) {
                frappe.throw(`Account Paid To is required in row ${row.idx}`);
            }
            if (!row.account_currency) {
                frappe.throw(`Account Currency is required in row ${row.idx}`);
            }
        });
    }
});
// -------- On Submit for Payment Entries --------
frappe.ui.form.on("Multiple Cheque Entry", "on_submit", function(frm) {
    const isPay = frm.doc.payment_type === "Pay";
    const isReceive = frm.doc.payment_type === "Receive";
    const table = isPay ? frm.doc.cheque_table_2 : frm.doc.cheque_table;
    if (!table || !table.length) return;
    let docs = [];
    table.forEach(row => {
        if (!row.payment_entry) {
            docs.push({
                doctype: "Payment Entry",
                posting_date: row.posting_date || frm.doc.posting_date,
                reference_doctype: "Multiple Cheque Entry",
                reference_link: frm.doc.name,
                payment_type: row.payment_type || frm.doc.payment_type,
                mode_of_payment: row.mode_of_payment || frm.doc.mode_of_payment,
                mode_of_payment_type: row.mode_of_payment_type || frm.doc.mode_of_payment_type,
                party_type: row.party_type || frm.doc.party_type,
                party: row.party || frm.doc.party,
                paid_from: isReceive ? row.paid_from : row.payable_account,
                paid_to: row.account_paid_to,
                paid_to_account_currency: row.account_currency,
                cheque_bank: row.cheque_bank || frm.doc.cheque_bank,
                bank_acc: row.bank_acc || frm.doc.bank_acc,
                cheque_type: row.cheque_type,
                reference_no: row.reference_no,
                reference_date: row.reference_date,
                paid_amount: row.paid_amount,
                received_amount: row.paid_amount,
                first_beneficiary: row.first_beneficiary,
                person_name: row.person_name,
                issuer_name: row.issuer_name,
                picture_of_check: row.picture_of_check,
                cheque_table_no: isReceive ? row.name : undefined,
                cheque_table_no2: isPay ? row.name : undefined
            });
        }
    });
    // Insert & Submit Each Entry Properly
    const funcs = docs.map(doc =>
        frappe.call({
            method: "frappe.client.insert",
            args: { doc },
            callback: function(inserted) {
                if (inserted.message) {
                    frappe.call({
                        method: "frappe.client.submit",
                        args: { doc: inserted.message },
                        callback: function(submitted) {
                            if (submitted.message) {
                                const child_doctype = isPay ? "Cheque Table Pay" : "Cheque Table Receive";
                                frappe.db.set_value(child_doctype, doc.cheque_table_no || doc.cheque_table_no2, "payment_entry", submitted.message.name);
                            }
                        }
                    });
                }
            }
        })
    );
    Promise.all(funcs).then(() => {
        frappe.msgprint("تم إنشاء الشيكات بنجاح ... برجاء مراجعة المدفوعات والمقبوضات.");
        frm.reload_doc();
    });
});
// -------- First Beneficiary Auto-Fill --------
frappe.ui.form.on("Cheque Table Pay", "first_beneficiary", function(frm) {
    frm.doc.cheque_table_2?.forEach(r => {
        r.person_name = frm.doc.party_name;
        r.issuer_name = frm.doc.company;
    });
    frm.refresh_field("cheque_table_2");
});
frappe.ui.form.on("Cheque Table Receive", "first_beneficiary", function(frm) {
    frm.doc.cheque_table?.forEach(r => {
        r.person_name = frm.doc.company;
        r.issuer_name = frm.doc.party_name;
    });
    frm.refresh_field("cheque_table");
});

// -------- Child Table Field Setup --------
frappe.ui.form.on("Multiple Cheque Entry", {
    refresh: function(frm) {
        // Set up queries for child table fields
        if (frm.fields_dict.cheque_table) {
            frm.fields_dict.cheque_table.grid.get_field('account_paid_to').get_query = function() {
                return {
                    filters: [["Account", "account_type", "in", ["Bank", "Cash"]]]
                };
            };
            frm.fields_dict.cheque_table.grid.get_field('account_currency').get_query = function() {
                return {
                    filters: [["Currency", "enabled", "=", 1]]
                };
            };
        }
        
        if (frm.fields_dict.cheque_table_2) {
            frm.fields_dict.cheque_table_2.grid.get_field('account_paid_to').get_query = function() {
                return {
                    filters: [["Account", "account_type", "in", ["Bank", "Cash"]]]
                };
            };
            frm.fields_dict.cheque_table_2.grid.get_field('account_currency').get_query = function() {
                return {
                    filters: [["Currency", "enabled", "=", 1]]
                };
            };
        }
    }
});

// -------- Auto-fill Child Table Fields --------
frappe.ui.form.on("Cheque Table Receive", {
    account_paid_to: function(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (row.account_paid_to) {
            // Get account currency from selected account
            frappe.call({
                method: "frappe.client.get_value",
                args: {
                    doctype: "Account",
                    fieldname: "account_currency",
                    filters: { name: row.account_paid_to }
                },
                callback: function(r) {
                    if (r.message) {
                        frappe.model.set_value(cdt, cdn, "account_currency", r.message.account_currency);
                        frm.refresh_field("cheque_table");
                    }
                }
            });
        }
    }
});

frappe.ui.form.on("Cheque Table Pay", {
    account_paid_to: function(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (row.account_paid_to) {
            // Get account currency from selected account
            frappe.call({
                method: "frappe.client.get_value",
                args: {
                    doctype: "Account",
                    fieldname: "account_currency",
                    filters: { name: row.account_paid_to }
                },
                callback: function(r) {
                    if (r.message) {
                        frappe.model.set_value(cdt, cdn, "account_currency", r.message.account_currency);
                        frm.refresh_field("cheque_table_2");
                    }
                }
            });
        }
    }
});
